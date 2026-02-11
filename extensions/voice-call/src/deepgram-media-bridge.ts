/**
 * Deepgram Media Bridge
 *
 * Bridges Twilio media stream WebSocket audio to/from a Deepgram Voice Agent
 * session. Used in hybrid mode where Twilio handles telephony and Deepgram
 * handles voice AI (STT, LLM, TTS).
 *
 * Flow:
 *   Twilio media stream WS → DeepgramMediaBridge → Deepgram Voice Agent API
 *                                  ↓                       ↓
 *                           audio back to Twilio    function calls → OpenClaw
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { CallManager } from "./manager.js";
import type { DeepgramVoiceAgentClient } from "./providers/deepgram-voice-agent.js";
import type { DeepgramProvider, DeepgramSessionOverrides } from "./providers/deepgram.js";
import type { CallRecord, NormalizedEvent } from "./types.js";
import { resolveAgentForNumber } from "./config.js";
import { loadCoreAgentDeps } from "./core-bridge.js";
import { TerminalStates } from "./types.js";
import { parseUserMarkdown } from "./user-md-parser.js";

/**
 * Configuration for the Deepgram media bridge.
 */
export interface DeepgramMediaBridgeConfig {
  /** DeepgramProvider instance for creating sessions */
  deepgramProvider: DeepgramProvider;
  /** CallManager for event processing and speaking */
  manager: CallManager;
  /** Validate whether to accept a media stream for the given call ID */
  shouldAcceptStream?: (params: { callId: string; streamSid: string; token?: string }) => boolean;
  /** Callback when stream connects */
  onConnect?: (callId: string, streamSid: string) => void;
  /** Callback when stream disconnects */
  onDisconnect?: (callId: string) => void;
  /** Gateway URL for LLM proxy (e.g., "http://127.0.0.1:18789") */
  gatewayUrl?: string;
  /** Gateway auth token */
  gatewayToken?: string;
  /** Public URL of webhook server (for think.endpoint) */
  publicUrl?: string;
  /** Core config for agent identity resolution */
  coreConfig?: CoreConfig;
  /** Voice call config for number-to-agent routing */
  voiceCallConfig?: VoiceCallConfig;
  /** Callback fired after a call ends (fire-and-forget) */
  onCallEnded?: (callRecord: CallRecord, agentId: string) => void;
}

/**
 * Active bridge session linking a Twilio stream to a Deepgram agent.
 */
interface BridgeSession {
  callId: string;
  streamSid: string;
  ws: WebSocket;
  client: DeepgramVoiceAgentClient;
}

/**
 * Bridges Twilio media streams to Deepgram Voice Agent sessions.
 *
 * Replaces MediaStreamHandler when in Deepgram hybrid mode. Instead of
 * forwarding audio to OpenAI Realtime STT, it forwards to Deepgram's
 * Voice Agent which handles STT, LLM, and TTS internally.
 */
export class DeepgramMediaBridge {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, BridgeSession>();
  private config: DeepgramMediaBridgeConfig;

  constructor(config: DeepgramMediaBridgeConfig) {
    this.config = config;
  }

  /**
   * Inject a filler phrase via the Deepgram agent for a given call.
   * Uses InjectAgentMessage so the agent speaks immediately (same as greeting).
   * Returns true if injected, false if no active session found.
   */
  injectFiller(callSid: string, phrase: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.callId === callSid) {
        session.client.injectAgentMessage(phrase);
        return true;
      }
    }
    return false;
  }

  /**
   * Handle WebSocket upgrade for media stream connections.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on("connection", (ws, req) => {
        void this.handleConnection(ws, req);
      });
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss?.emit("connection", ws, request);
    });
  }

  /**
   * Handle new WebSocket connection from Twilio.
   */
  private async handleConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    let session: BridgeSession | null = null;
    let mediaCount = 0;
    // Try URL first (fallback), but Twilio sends token via start.customParameters
    let streamToken = this.getStreamToken(request);

    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as TwilioMediaMessage;

        switch (message.event) {
          case "connected":
            console.log("[DeepgramBridge] Twilio connected");
            break;

          case "start":
            // Extract token from Twilio's customParameters (preferred over URL query)
            if (message.start?.customParameters?.token) {
              streamToken = message.start.customParameters.token;
              console.log(
                `[DeepgramBridge] Got token from customParameters: ${streamToken.substring(0, 8)}...`,
              );
            }
            session = await this.handleStart(ws, message, streamToken);
            break;

          case "media":
            if (session && message.media?.payload) {
              const audioBuffer = Buffer.from(message.media.payload, "base64");
              if (!mediaCount) {
                console.log(`[DeepgramBridge] First media packet: ${audioBuffer.length}B`);
              }
              mediaCount++;
              this.config.deepgramProvider.sendAudio(session.callId, audioBuffer);
            }
            break;

          case "stop":
            if (session) {
              this.handleStop(session);
              session = null;
            }
            break;
        }
      } catch (error) {
        console.error("[DeepgramBridge] Error processing message:", error);
      }
    });

    ws.on("close", () => {
      if (session) {
        this.handleStop(session);
      }
    });

    ws.on("error", (error) => {
      console.error("[DeepgramBridge] WebSocket error:", error);
    });
  }

  /**
   * Handle stream start event — create Deepgram session and wire bidirectional audio.
   */
  private async handleStart(
    ws: WebSocket,
    message: TwilioMediaMessage,
    streamToken?: string,
  ): Promise<BridgeSession | null> {
    const streamSid = message.streamSid || "";
    const callSid = message.start?.callSid || "";

    console.log(`[DeepgramBridge] Stream started: ${streamSid} (call: ${callSid})`);

    if (!callSid) {
      console.warn("[DeepgramBridge] Missing callSid; closing stream");
      ws.close(1008, "Missing callSid");
      return null;
    }

    if (
      this.config.shouldAcceptStream &&
      !this.config.shouldAcceptStream({ callId: callSid, streamSid, token: streamToken })
    ) {
      console.warn(`[DeepgramBridge] Rejecting stream for unknown call: ${callSid}`);
      ws.close(1008, "Unknown call");
      return null;
    }

    try {
      // Build per-call overrides for gateway integration
      const overrides = await this.buildSessionOverrides(callSid, message);
      const client = await this.config.deepgramProvider.createSession(callSid, callSid, overrides);

      const session: BridgeSession = { callId: callSid, streamSid, ws, client };
      this.sessions.set(streamSid, session);

      // Bridge: Deepgram audio → Twilio
      let audioChunks = 0;
      let audioBytes = 0;
      client.on("audio", (audio: Buffer) => {
        audioChunks++;
        audioBytes += audio.length;
        if (audioChunks === 1 || audioChunks % 50 === 0) {
          console.log(
            `[DeepgramBridge] Audio chunk #${audioChunks}: ${audio.length}B (total: ${audioBytes}B) wsState=${ws.readyState}`,
          );
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: audio.toString("base64") },
            }),
          );
        }
      });

      // Bridge: Deepgram conversation text → manager events
      client.on("conversationText", (role: string, content: string) => {
        console.log(
          `[DeepgramBridge] ConversationText: role=${role} content="${content.substring(0, 100)}"`,
        );
        const event: NormalizedEvent = {
          id: `dg-bridge-${crypto.randomUUID()}`,
          callId: callSid,
          providerCallId: callSid,
          timestamp: Date.now(),
          ...(role === "user"
            ? { type: "call.speech" as const, transcript: content, isFinal: true, confidence: 1.0 }
            : { type: "call.speaking" as const, text: content }),
        };
        this.config.manager.processEvent(event);
      });

      // Barge-in: when user starts speaking, clear Twilio's audio buffer
      client.on("userStartedSpeaking", () => {
        console.log(`[DeepgramBridge] User started speaking (barge-in)`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "clear", streamSid }));
        }
      });

      client.on("agentStartedSpeaking", (latency) => {
        console.log(
          `[DeepgramBridge] Agent started speaking (total=${latency?.total}ms tts=${latency?.tts}ms ttt=${latency?.ttt}ms)`,
        );
      });

      client.on("agentAudioDone", () => {
        console.log(
          `[DeepgramBridge] Agent audio done (sent ${audioChunks} chunks, ${audioBytes}B)`,
        );
      });

      client.on("agentThinking", () => {
        console.log(`[DeepgramBridge] Agent thinking...`);
      });

      client.on("injectionRefused", (reason) => {
        console.warn(`[DeepgramBridge] Injection refused: ${reason}`);
      });

      client.on("error", (error: Error) => {
        console.error(`[DeepgramBridge] Deepgram error for ${callSid}:`, error.message);
      });

      // Notify connection
      this.config.onConnect?.(callSid, streamSid);

      // Speak initial greeting via Deepgram agent (not TwilioProvider.playTts).
      // For notify-mode calls, schedule auto-hangup once the agent finishes speaking.
      setTimeout(() => {
        const call = this.config.manager.getCallByProviderCallId(callSid);
        const initialMessage =
          typeof call?.metadata?.initialMessage === "string"
            ? call.metadata.initialMessage.trim()
            : "";
        if (initialMessage && call?.metadata) {
          const mode = (call.metadata.mode as string) ?? "conversation";
          delete call.metadata.initialMessage;
          console.log(
            `[DeepgramBridge] Injecting initial greeting via Deepgram agent (mode=${mode})`,
          );
          client.injectAgentMessage(initialMessage);

          // In notify mode, auto-hangup after the agent finishes speaking the message
          if (mode === "notify") {
            const delaySec = this.config.voiceCallConfig?.outbound.notifyHangupDelaySec ?? 3;
            client.once("agentAudioDone", () => {
              console.log(
                `[DeepgramBridge] Notify mode: agent audio done, scheduling hangup in ${delaySec}s`,
              );
              setTimeout(async () => {
                const currentCall = this.config.manager.getCallByProviderCallId(callSid);
                if (currentCall && !TerminalStates.has(currentCall.state)) {
                  console.log(
                    `[DeepgramBridge] Notify mode: hanging up call ${currentCall.callId}`,
                  );
                  await this.config.manager.endCall(currentCall.callId);
                }
              }, delaySec * 1000);
            });
          }
        }
      }, 500);

      return session;
    } catch (error) {
      console.error(`[DeepgramBridge] Failed to create Deepgram session for ${callSid}:`, error);
      ws.close(1011, "Deepgram session creation failed");
      return null;
    }
  }

  /**
   * Build per-call session overrides for gateway integration.
   * Routes LLM calls through the gateway's /v1/chat/completions endpoint.
   */
  private async buildSessionOverrides(
    callSid: string,
    _message: TwilioMediaMessage,
  ): Promise<DeepgramSessionOverrides | undefined> {
    if (!this.config.gatewayUrl || !this.config.gatewayToken || !this.config.publicUrl) {
      return undefined;
    }

    // Get caller info from manager
    const call = this.config.manager.getCallByProviderCallId(callSid);
    const callerNumber = call?.from || "unknown";
    const calledNumber = call?.to;

    // Resolve agent ID from number routing config
    const agentId = this.config.voiceCallConfig
      ? resolveAgentForNumber(this.config.voiceCallConfig, calledNumber, "inbound")
      : "main";

    // Resolve agent identity for system prompt
    let agentName = "Assistant";
    try {
      if (this.config.coreConfig) {
        const deps = await loadCoreAgentDeps();
        const identity = deps.resolveAgentIdentity(this.config.coreConfig, agentId);
        if (identity?.name) {
          agentName = identity.name;
        }
      }
    } catch (err) {
      console.warn("[DeepgramBridge] Failed to resolve agent identity:", err);
    }

    console.log(
      `[DeepgramBridge] Resolved agent: id=${agentId} name=${agentName} calledNumber=${calledNumber}`,
    );

    // Load caller context from workspace files (USER.md, CALLS.md)
    let callerName: string | undefined;
    const callerContextLines: string[] = [];
    try {
      if (this.config.coreConfig) {
        const deps = await loadCoreAgentDeps();
        const workspaceDir = deps.resolveAgentWorkspaceDir(this.config.coreConfig, agentId);

        // Parse USER.md with proper parser
        const userMdPath = `${workspaceDir}/USER.md`;
        try {
          const userMd = await fs.readFile(userMdPath, "utf-8");
          const userProfile = parseUserMarkdown(userMd);
          callerName = userProfile.callName || userProfile.name;
          if (callerName) {
            callerContextLines.push(`The caller's name is ${callerName}. Greet them by name.`);
          }
          if (userProfile.notes) {
            callerContextLines.push(`About the caller: ${userProfile.notes}`);
          }
          if (userProfile.context) {
            callerContextLines.push(`Context: ${userProfile.context}`);
          }
        } catch {
          // USER.md not found or unreadable — skip
        }

        // Parse CALLS.md for rich recent call context
        const callsMdPath = `${workspaceDir}/CALLS.md`;
        try {
          const callsMd = await fs.readFile(callsMdPath, "utf-8");
          const recentEntries = getRecentCallEntries(callsMd, 3);
          if (recentEntries.length > 0) {
            callerContextLines.push(`Recent calls with this person:`);
            for (const entry of recentEntries) {
              callerContextLines.push(`- ${entry}`);
            }
            callerContextLines.push(
              `Reference ONE specific detail from a recent call naturally within the first 15 seconds. Keep it casual — not a data dump.`,
            );
          }
        } catch {
          // CALLS.md not found — skip
        }
      }
    } catch (err) {
      console.warn("[DeepgramBridge] Failed to load caller context:", err);
    }

    // Personalize the initial greeting
    if (call?.metadata?.initialMessage) {
      if (callerName) {
        const greetings = [
          `Hey ${callerName}! What's going on?`,
          `${callerName}, hey! What can I do for you?`,
          `Hey ${callerName}, good to hear from you. What's up?`,
          `${callerName}! What's on your mind?`,
          `Hey there ${callerName}. How can I help?`,
          `${callerName}, what's up?`,
        ];
        call.metadata.initialMessage = greetings[Math.floor(Math.random() * greetings.length)];
      } else if (callerContextLines.length === 0) {
        // First call — establish it's a fresh setup, kick off mutual introductions
        call.metadata.initialMessage =
          "Hey! This is a fresh DeepClaw setup, so we're just getting to know each other. What's your name?";
      }
    }

    // Build system prompt with voice-specific behavioral instructions only.
    // Agent identity comes from workspace files (SOUL.md, IDENTITY.md, BOOTSTRAP.md)
    // loaded by the Pi agent's normal startup path.
    // Format current date/time in the configured timezone
    const tz = this.config.voiceCallConfig?.timezone ?? "UTC";
    const now = new Date();
    const localTime = now.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });

    const promptLines = [
      `You are on a phone call. Keep responses brief and conversational (1-2 sentences max).`,
      `Speak naturally as if in a real phone conversation.`,
      `IMPORTANT: Your responses will be spoken aloud via text-to-speech. Do NOT use any text formatting — no markdown, no bullet points, no asterisks, no numbered lists, no headers. Write plain conversational sentences only.`,
      `Do NOT start your response with filler phrases like "Let me check" or "One moment" — that is handled automatically. Jump straight into the answer.`,
      `If a request is ambiguous or you're unsure what the caller means, ask a quick clarifying question before acting. Don't guess or add requirements they didn't ask for.`,
      `Today is ${localTime}. Always present times in this timezone.`,
      `The caller's phone number is ${callerNumber}.`,
    ];
    if (callerContextLines.length > 0) {
      promptLines.push(...callerContextLines);
    } else {
      // First call — no USER.md data, no CALLS.md. Guide the onboarding.
      const nameLabel = agentName !== "Assistant" ? agentName : "your AI voice assistant";
      promptLines.push(
        `This is a brand new setup — you've never spoken with this caller before.`,
        `Introduce yourself as ${nameLabel}. Be warm and confident, not robotic.`,
        `Within the first exchange, naturally ask their name if you don't have it yet.`,
        `IMPORTANT: When someone says "call me [name]" or "you can call me [name]", they are telling you their NAME — they want to be addressed as that name. This is NOT a request to make a phone call. Respond by confirming the name, e.g. "Got it, [name]."`,
        `Give a brief taste of what you can do — answer questions, help think through problems, look things up. Keep it to one or two examples, don't list everything.`,
        `If you don't have a name yet (IDENTITY.md is blank), pick one that feels right and tell them. Own it.`,
        `The goal is: by the end of this call, you know each other's names and the caller has a feel for what you're about.`,
      );
    }
    const systemPrompt = promptLines.join("\n");

    // Per-call session key — each call gets a fresh session.
    // Agent identity persists via workspace files (SOUL.md, IDENTITY.md), not session history.
    return {
      systemPrompt,
      llmProvider: "open_ai",
      llmEndpoint: {
        url: `${this.config.publicUrl}/v1/chat/completions`,
        headers: {
          Authorization: `Bearer ${this.config.gatewayToken}`,
          "x-openclaw-session-key": `agent:${agentId}:voice:${callSid}`,
          "x-openclaw-agent-id": agentId,
        },
      },
    };
  }

  /**
   * Handle stream stop event — close Deepgram session and clean up.
   */
  private handleStop(session: BridgeSession): void {
    console.log(`[DeepgramBridge] Stream stopped: ${session.streamSid}`);
    const callRecord = this.config.manager.getCallByProviderCallId(session.callId);

    // Best-effort: mark the call as ended even if Twilio status callbacks are missed.
    // This prevents stale non-terminal call records from blocking new calls after restart.
    try {
      const endedEvent: NormalizedEvent = {
        id: `dg-bridge-ended-${crypto.randomUUID()}`,
        type: "call.ended",
        callId: callRecord?.callId ?? session.callId,
        providerCallId: session.callId,
        timestamp: Date.now(),
        reason: "completed",
        direction: callRecord?.direction,
        from: callRecord?.from,
        to: callRecord?.to,
      };
      this.config.manager.processEvent(endedEvent);
    } catch (err) {
      console.warn(
        `[DeepgramBridge] Failed to mark call ended for ${session.callId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    this.config.deepgramProvider.closeSession(session.callId);
    this.sessions.delete(session.streamSid);
    this.config.onDisconnect?.(session.callId);

    // Fire post-call callback (fire-and-forget)
    if (this.config.onCallEnded) {
      if (callRecord) {
        const calledNumber = callRecord.direction === "inbound" ? callRecord.to : callRecord.from;
        const agentId = this.config.voiceCallConfig
          ? resolveAgentForNumber(this.config.voiceCallConfig, calledNumber, "inbound")
          : "main";
        try {
          this.config.onCallEnded(callRecord, agentId);
        } catch (err) {
          console.error(`[DeepgramBridge] onCallEnded callback error:`, err);
        }
      }
    }
  }

  private getStreamToken(request: IncomingMessage): string | undefined {
    console.log(`[DeepgramBridge] getStreamToken: url=${request.url} host=${request.headers.host}`);
    if (!request.url || !request.headers.host) {
      console.log(`[DeepgramBridge] getStreamToken: missing url or host`);
      return undefined;
    }
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get("token") ?? undefined;
      console.log(
        `[DeepgramBridge] getStreamToken: parsed token=${token ? token.substring(0, 8) + "..." : "NONE"} fullUrl=${url.toString()}`,
      );
      return token;
    } catch (err) {
      console.log(`[DeepgramBridge] getStreamToken: URL parse error: ${err}`);
      return undefined;
    }
  }

  /**
   * Close all active bridge sessions.
   */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      this.config.deepgramProvider.closeSession(session.callId);
      session.ws.close();
    }
    this.sessions.clear();
  }
}

/**
 * Extract the most recent call entries from CALLS.md content.
 * Each entry starts with `### ` (h3 heading). Returns the last `count` entries
 * as single-line summaries (heading text only, trimmed).
 */
function getRecentCallEntries(callsMd: string, count: number): string[] {
  const parts = callsMd.split(/(?=^### )/m).slice(1); // skip content before first entry
  return parts.slice(-count).map((entry) => entry.replace(/^### /, "").split("\n")[0]!.trim());
}

/**
 * Twilio Media Stream message format (same protocol as MediaStreamHandler).
 */
interface TwilioMediaMessage {
  event: "connected" | "start" | "media" | "stop" | "mark" | "clear";
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    customParameters?: Record<string, string>;
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
  media?: {
    track?: string;
    chunk?: string;
    timestamp?: string;
    payload?: string;
  };
  mark?: {
    name: string;
  };
}
