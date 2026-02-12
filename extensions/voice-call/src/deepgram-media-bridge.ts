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
import { resolveAgentForNumber, SessionTimerConfigSchema } from "./config.js";
import { loadCoreAgentDeps } from "./core-bridge.js";
import { SessionTimers } from "./session-timers.js";
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
  timers: SessionTimers;
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
      // Ensure a call record exists — streams may arrive without a prior webhook
      // POST (e.g., when a control plane proxy handles Twilio and forwards the
      // media stream directly). This creates the record with a default greeting.
      this.config.manager.ensureCallForStream(callSid);

      // Build per-call overrides for gateway integration
      const overrides = await this.buildSessionOverrides(callSid, message);
      const client = await this.config.deepgramProvider.createSession(callSid, callSid, overrides);

      // Create session timers for response timeout + idle caller detection.
      // Parse through Zod to ensure all defaults are applied — the raw config
      // may be an empty {} if sessionTimers wasn't in the config file.
      const timerConfig = SessionTimerConfigSchema.parse(
        this.config.voiceCallConfig?.sessionTimers ?? {},
      );
      const timers = new SessionTimers(timerConfig, {
        injectAgentMessage: (msg) => client.injectAgentMessage(msg),
        endCall: async () => {
          const call = this.config.manager.getCallByProviderCallId(callSid);
          if (call && !TerminalStates.has(call.state)) {
            await this.config.manager.endCall(call.callId);
          }
        },
        log: (msg) => console.log(msg),
      });

      const session: BridgeSession = { callId: callSid, streamSid, ws, client, timers };
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
        if (role === "user") {
          timers.onUserSpoke();
        } else if (role === "assistant") {
          timers.onAgentStartedSpeaking();
        }
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
        timers.onUserStartedSpeaking();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "clear", streamSid }));
        }
      });

      client.on("agentStartedSpeaking", (latency) => {
        console.log(
          `[DeepgramBridge] Agent started speaking (total=${latency?.total}ms tts=${latency?.tts}ms ttt=${latency?.ttt}ms)`,
        );
        timers.onAgentStartedSpeaking();
      });

      client.on("agentAudioDone", () => {
        console.log(
          `[DeepgramBridge] Agent audio done (sent ${audioChunks} chunks, ${audioBytes}B)`,
        );
        timers.onAgentAudioDone();
      });

      client.on("agentThinking", () => {
        console.log(`[DeepgramBridge] Agent thinking...`);
      });

      client.on("injectionRefused", (reason) => {
        console.warn(`[DeepgramBridge] Injection refused: ${reason}`);
      });

      // Handle end_call function from LLM — graceful call ending
      client.on("functionCall", (name: string, args: Record<string, unknown>, fnCallId: string) => {
        if (name === "end_call") {
          console.log(
            `[DeepgramBridge] end_call function called: farewell=${JSON.stringify(args.farewell)}`,
          );
          timers.clearAll();
          client.sendFunctionCallResponse(fnCallId, "end_call", JSON.stringify({ ok: true }));
          const farewell = typeof args.farewell === "string" ? args.farewell : "Goodbye!";
          client.injectAgentMessage(farewell);
          client.once("agentAudioDone", () => {
            setTimeout(async () => {
              const call = this.config.manager.getCallByProviderCallId(callSid);
              if (call && !TerminalStates.has(call.state)) {
                console.log(`[DeepgramBridge] end_call: hanging up call ${call.callId}`);
                await this.config.manager.endCall(call.callId);
              }
            }, 1000);
          });
        }
      });

      client.on("error", (error: Error) => {
        console.error(`[DeepgramBridge] Deepgram error for ${callSid}:`, error.message);
      });

      // Notify connection
      this.config.onConnect?.(callSid, streamSid);

      // Speak initial greeting via Deepgram agent (not TwilioProvider.playTts).
      // For notify-mode calls, schedule auto-hangup once the agent finishes speaking.
      console.log(`[DeepgramBridge] Scheduling greeting injection in 500ms for call=${callSid}`);
      setTimeout(() => {
        const call = this.config.manager.getCallByProviderCallId(callSid);
        console.log(
          `[DeepgramBridge] Greeting timer fired for call=${callSid}: callFound=${!!call} hasMetadata=${!!call?.metadata} initialMessage=${JSON.stringify(call?.metadata?.initialMessage)} callState=${call?.state}`,
        );
        const initialMessage =
          typeof call?.metadata?.initialMessage === "string"
            ? call.metadata.initialMessage.trim()
            : "";
        if (initialMessage && call?.metadata) {
          const mode = (call.metadata.mode as string) ?? "conversation";
          delete call.metadata.initialMessage;
          console.log(
            `[DeepgramBridge] Injecting initial greeting via Deepgram agent (mode=${mode}, length=${initialMessage.length}): "${initialMessage.substring(0, 80)}"`,
          );
          client.injectAgentMessage(initialMessage);

          // In notify mode, disable session timers and auto-hangup after speaking
          if (mode === "notify") {
            timers.clearAll();
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
        } else {
          console.log(
            `[DeepgramBridge] No greeting to inject for call=${callSid}: initialMessage=${JSON.stringify(initialMessage) || "(empty)"} hasMetadata=${!!call?.metadata}`,
          );
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
        } catch {}

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
              `Within the first 15 seconds, casually reference ONE specific detail from a recent interaction — a call topic, something they texted about, a question from another channel. Like a friend checking in, not a data readback.`,
              `Within the first 45 seconds, naturally steer toward offering a concrete action — send a text, set a reminder, look something up. Frame it as a natural offer ("Want me to text you that?"), not a feature pitch. If they already asked for something, just do it.`,
            );
          }
        } catch {
          // CALLS.md not found — skip
        }

        // Load cross-channel context (SMS, Slack, web chat, etc.)
        try {
          const storePath = deps.resolveStorePath(this.config.coreConfig?.session?.store, {
            agentId,
          });
          const sessions = loadRecentNonVoiceSessions(deps.loadSessionStore(storePath));
          const briefing = buildCrossChannelBriefing(sessions);
          if (briefing) {
            callerContextLines.push(briefing);
          }
        } catch {
          // Non-critical — fall through silently
        }
      }
    } catch (err) {
      console.warn("[DeepgramBridge] Failed to load caller context:", err);
    }

    // Personalize the initial greeting
    console.log(
      `[DeepgramBridge] Greeting personalization: callSid=${callSid} hasCall=${!!call} hasMetadata=${!!call?.metadata} initialMessage=${JSON.stringify(call?.metadata?.initialMessage)} callerName=${callerName ?? "(none)"} contextLines=${callerContextLines.length}`,
    );
    if (call?.metadata?.initialMessage) {
      console.log(
        `[DeepgramBridge] Personalizing greeting: callerName=${callerName ?? "none"} agentName=${agentName} contextLines=${callerContextLines.length}`,
      );
      if (callerName) {
        const greetings = [
          `Hey ${callerName}! What's going on?`,
          `${callerName}, hey! What can I do for you?`,
          `Hey ${callerName}, good to hear from you. What's up?`,
          `${callerName}! What's on your mind?`,
          `Hey there ${callerName}. How can I help?`,
          `${callerName}, what's up?`,
        ];
        const chosen = greetings[Math.floor(Math.random() * greetings.length)];
        console.log(`[DeepgramBridge] Personalized greeting for ${callerName}: "${chosen}"`);
        call.metadata.initialMessage = chosen;
      } else if (callerContextLines.length === 0) {
        // First call — establish it's a fresh setup, kick off mutual introductions
        call.metadata.initialMessage =
          "Hey! This is a fresh DeepClaw setup, so we're just getting to know each other. What should I call you?";
        console.log(`[DeepgramBridge] Using first-call greeting (no caller context)`);
      } else {
        console.log(`[DeepgramBridge] Keeping default greeting (has context but no callerName)`);
      }
    } else {
      console.log(
        `[DeepgramBridge] No initialMessage on call metadata — skipping greeting personalization`,
      );
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
      `You can send the caller a text message by calling the "message" function tool with action "send", channel "twilio-sms", and target "${callerNumber}". Call the tool directly — do NOT use bash or exec to run "openclaw" commands. When the caller asks you to text them something, actually call the message tool — don't just say you did it.`,
    ];
    if (callerContextLines.length > 0) {
      promptLines.push(...callerContextLines);
    } else {
      // First call — no USER.md data, no CALLS.md. Guide the onboarding.
      promptLines.push(
        `This is a brand new setup — you've never spoken with this caller before.`,
        `You don't have a name yet — that's fine. Don't try to pick one or announce one. If the caller asks your name, say you haven't picked one yet and you're open to suggestions. Your name will be figured out after the call.`,
        `Within the first exchange, naturally ask their name if you don't have it yet.`,
        `IMPORTANT: When someone says "call me [name]" or "you can call me [name]", they are telling you their NAME — they want to be addressed as that name. This is NOT a request to make a phone call. Respond by confirming the name, e.g. "Got it, [name]."`,
        `Show what you can do by offering to DO something right now — "Want me to look something up and text it to you?" or "I can set a reminder if you need one." One real action beats a list of capabilities.`,
        `The goal is: by the end of this call, you know each other's names, the caller has seen you do something useful, and they have a reason to call back.`,
      );
    }
    const systemPrompt = promptLines.join("\n");

    // Per-call session key — each call gets a fresh session.
    // Agent identity persists via workspace files (SOUL.md, IDENTITY.md), not session history.
    const llmEndpointUrl = `${this.config.publicUrl}/v1/chat/completions`;
    const llmHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.config.gatewayToken}`,
      "x-openclaw-session-key": `agent:${agentId}:voice:${callSid}`,
      "x-openclaw-agent-id": agentId,
      ...(process.env.FLY_MACHINE_ID && {
        "fly-force-instance-id": process.env.FLY_MACHINE_ID,
      }),
    };
    console.log(
      `[DeepgramBridge] LLM endpoint config: url=${llmEndpointUrl} publicUrl=${this.config.publicUrl} gatewayToken=${this.config.gatewayToken ? this.config.gatewayToken.substring(0, 8) + "..." : "(empty)"} sessionKey=agent:${agentId}:voice:${callSid} flyMachineId=${process.env.FLY_MACHINE_ID ?? "(unset)"}`,
    );
    return {
      systemPrompt,
      llmProvider: "open_ai",
      llmEndpoint: {
        url: llmEndpointUrl,
        headers: llmHeaders,
      },
    };
  }

  /**
   * Handle stream stop event — close Deepgram session and clean up.
   */
  private handleStop(session: BridgeSession): void {
    session.timers.clearAll();
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

    // Fire post-call callback and notify child sessions (fire-and-forget)
    if (callRecord) {
      const calledNumber = callRecord.direction === "inbound" ? callRecord.to : callRecord.from;
      const agentId = this.config.voiceCallConfig
        ? resolveAgentForNumber(this.config.voiceCallConfig, calledNumber, "inbound")
        : "main";
      if (this.config.onCallEnded) {
        try {
          this.config.onCallEnded(callRecord, agentId);
        } catch (err) {
          console.error(`[DeepgramBridge] onCallEnded callback error:`, err);
        }
      }
      // Notify child sessions spawned during this call (fire-and-forget)
      void this.notifyChildSessions(session.callId, agentId);
    }
  }

  /**
   * Notify child sessions spawned during this voice call that the call has ended.
   * Child sessions (e.g. background tasks like calendar lookups) have `spawnedBy`
   * set to this call's session key. We query for them and send a message so they
   * can fall back to SMS delivery instead of trying to announce to the ended call.
   */
  private async notifyChildSessions(callSid: string, agentId: string): Promise<void> {
    if (!this.config.gatewayUrl || !this.config.gatewayToken) return;

    const voiceSessionKey = `agent:${agentId}:voice:${callSid}`;
    try {
      const deps = await loadCoreAgentDeps();
      const result = await deps.callGateway<{ sessions: Array<{ key: string }> }>({
        url: this.config.gatewayUrl,
        token: this.config.gatewayToken,
        method: "sessions.list",
        params: {
          spawnedBy: voiceSessionKey,
          limit: 50,
          includeGlobal: false,
          includeUnknown: false,
        },
        timeoutMs: 5_000,
      });

      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      if (sessions.length === 0) return;

      console.log(`[DeepgramBridge] Notifying ${sessions.length} child session(s) of call end`);

      for (const session of sessions) {
        try {
          await deps.callGateway({
            url: this.config.gatewayUrl,
            token: this.config.gatewayToken,
            method: "agent",
            params: {
              message:
                "The voice call has ended — the caller is no longer on the phone. If you have results to deliver, send them via SMS using the message tool instead.",
              sessionKey: session.key,
              idempotencyKey: crypto.randomUUID(),
            },
            timeoutMs: 10_000,
          });
        } catch (err) {
          console.warn(`[DeepgramBridge] Failed to notify child session ${session.key}:`, err);
        }
      }
    } catch (err) {
      console.warn(`[DeepgramBridge] Failed to query child sessions:`, err);
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
 * with heading + body summary (trimmed to ~150 chars to keep prompt budget manageable).
 */
function getRecentCallEntries(callsMd: string, count: number): string[] {
  const parts = callsMd.split(/(?=^### )/m).slice(1); // skip content before first entry
  return parts.slice(-count).map((entry) => {
    const lines = entry.split("\n").filter((l) => l.trim());
    const heading = lines[0]!.replace(/^### /, "").trim();
    const body = lines.slice(1).join(" ").trim();
    const summary = body.length > 150 ? body.slice(0, 147) + "..." : body;
    return summary ? `${heading}: ${summary}` : heading;
  });
}

/**
 * Session entry shape from loadSessionStore() — minimal subset for cross-channel loading.
 */
interface SessionStoreEntry {
  updatedAt?: number;
  lastChannel?: string;
  channel?: string;
  displayName?: string;
  subject?: string;
  label?: string;
}

/**
 * Map channel identifiers to human-readable labels for voice context.
 */
function formatChannelLabel(channel: string): string {
  const labels: Record<string, string> = {
    "twilio-sms": "SMS",
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    discord: "Discord",
    slack: "Slack",
    signal: "Signal",
    imessage: "iMessage",
    googlechat: "Google Chat",
    webchat: "web chat",
  };
  return labels[channel] ?? channel;
}

/**
 * Format a timestamp as a human-friendly relative time string.
 */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Filter session store to recent non-voice sessions for cross-channel context.
 * Excludes voice calls (already in CALLS.md), call summaries, and internal sessions.
 * Returns the 5 most recent sessions updated within the last 7 days.
 */
function loadRecentNonVoiceSessions(
  store: Record<string, unknown>,
): Array<{ key: string; channel: string; title: string; updatedAt: number }> {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const results: Array<{ key: string; channel: string; title: string; updatedAt: number }> = [];

  for (const [key, raw] of Object.entries(store)) {
    // Skip voice calls, call summaries, and internal sessions
    if (key.includes(":voice:") || key.includes(":call-summary:")) continue;
    if (key.startsWith("cron:") || key.startsWith("hook:") || key.startsWith("node:")) continue;

    const entry = raw as SessionStoreEntry;
    if (!entry.updatedAt || entry.updatedAt < sevenDaysAgo) continue;

    const channel = entry.lastChannel || entry.channel;
    if (!channel) continue;

    const title = entry.displayName || entry.subject || entry.label || "";
    if (!title) continue;

    results.push({ key, channel, title, updatedAt: entry.updatedAt });
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
}

/**
 * Build a concise cross-channel briefing block for the voice system prompt.
 * Returns undefined if there are no relevant sessions.
 */
function buildCrossChannelBriefing(
  sessions: Array<{ channel: string; title: string; updatedAt: number }>,
): string | undefined {
  if (sessions.length === 0) return undefined;
  const lines = sessions.map(
    (s) => `- ${formatChannelLabel(s.channel)} (${formatRelativeTime(s.updatedAt)}): ${s.title}`,
  );
  return `Recent conversations on other channels:\n${lines.join("\n")}`;
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
