import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import { WebSocket } from "ws";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DeepgramVoiceAgentClient,
  type DeepgramVoiceAgentConfig,
  type DeepgramAudioEncoding,
  type DeepgramOutputEncoding,
} from "../../extensions/voice-call/src/providers/deepgram-voice-agent.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const VOICE_STREAM_PATH = "/voice/stream";

type StreamFormat = "twilio" | "browser";

function resolveDeepgramApiKey(): string | null {
  const envResult = resolveEnvApiKey("deepgram");
  return envResult?.apiKey ?? null;
}

/**
 * Resolve the LLM endpoint for the Deepgram Voice Agent's think stage.
 *
 * The think.endpoint is called by Deepgram's cloud servers (not our instance),
 * so it must be publicly reachable. Two strategies:
 *
 * 1. If the gateway has a public URL (e.g. Fly machine URL), route through
 *    the gateway's /v1/chat/completions endpoint.
 * 2. Otherwise fall back to ANTHROPIC_BASE_URL (LiteLLM proxy, which is public).
 */
function resolveLlmEndpoint():
  | {
      url: string;
      headers: Record<string, string>;
    }
  | undefined {
  // Strategy 1: Route through public gateway URL
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  const publicUrl = process.env.OPENCLAW_PUBLIC_URL?.trim();
  if (publicUrl && gatewayToken) {
    return {
      url: `${publicUrl}/v1/chat/completions`,
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
      },
    };
  }

  // Strategy 2: Route directly to LiteLLM proxy
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicBaseUrl && anthropicApiKey) {
    return {
      url: `${anthropicBaseUrl}/v1/chat/completions`,
      headers: {
        Authorization: `Bearer ${anthropicApiKey}`,
      },
    };
  }

  return undefined;
}

function buildSystemPrompt(params: {
  userId?: string;
  phoneNumber?: string;
  callSid?: string;
}): string {
  const lines = [
    "You are on a voice call. Keep responses brief and conversational (1-2 sentences max).",
    "Speak naturally as if in a real conversation.",
    "IMPORTANT: Your responses will be spoken aloud via text-to-speech. Do NOT use any text formatting — no markdown, no bullet points, no asterisks, no numbered lists, no headers. Write plain conversational sentences only.",
    'When you need to use a tool or look something up, ALWAYS say a brief acknowledgment first (e.g. "Let me check that for you" or "One moment") so the caller isn\'t waiting in silence.',
  ];

  const now = new Date();
  const localTime = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  lines.push(`Today is ${localTime}.`);

  if (params.phoneNumber) {
    lines.push(`The caller's phone number is ${params.phoneNumber}.`);
  }

  return lines.join("\n");
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (Array.isArray(val)) {
    return val[0];
  }
  return val ?? undefined;
}

// ---------------------------------------------------------------------------
// Twilio stream handler
// ---------------------------------------------------------------------------

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
  stop?: {
    accountSid?: string;
    callSid?: string;
  };
}

function handleTwilioStream(
  clientWs: WebSocket,
  dgClient: DeepgramVoiceAgentClient,
  log: SubsystemLogger,
): void {
  let streamSid: string | undefined;

  clientWs.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const raw = Buffer.isBuffer(data)
        ? data.toString()
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString()
          : Buffer.concat(data).toString();
      const message = JSON.parse(raw) as TwilioMediaMessage;

      switch (message.event) {
        case "connected":
          log.info("voice-stream: twilio connected");
          break;

        case "start":
          streamSid = message.start?.streamSid ?? message.streamSid;
          log.info(
            `voice-stream: twilio stream started (streamSid=${streamSid}, callSid=${message.start?.callSid})`,
          );
          break;

        case "media":
          if (message.media?.payload) {
            const audioBuffer = Buffer.from(message.media.payload, "base64");
            dgClient.sendAudio(audioBuffer);
          }
          break;

        case "stop":
          log.info("voice-stream: twilio stream stopped");
          dgClient.close();
          break;
      }
    } catch (err) {
      log.warn(`voice-stream: failed to parse twilio message: ${String(err)}`);
    }
  });

  // Deepgram audio → Twilio media JSON
  dgClient.on("audio", (audio: Buffer) => {
    if (clientWs.readyState === WebSocket.OPEN && streamSid) {
      clientWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: audio.toString("base64") },
        }),
      );
    }
  });

  // Barge-in: clear Twilio's audio buffer
  dgClient.on("userStartedSpeaking", () => {
    if (clientWs.readyState === WebSocket.OPEN && streamSid) {
      clientWs.send(JSON.stringify({ event: "clear", streamSid }));
    }
  });

  dgClient.on("conversationText", (role: string, content: string) => {
    log.info(`voice-stream: [${role}] ${content.substring(0, 80)}`);
  });

  dgClient.on("error", (error: Error) => {
    log.warn(`voice-stream: deepgram error: ${error.message}`);
  });

  dgClient.on("closed", (code: number, reason: string) => {
    log.info(`voice-stream: deepgram closed (${code}): ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1000, "Deepgram closed");
    }
  });

  clientWs.on("close", () => {
    log.info("voice-stream: twilio client disconnected");
    dgClient.close();
  });

  clientWs.on("error", (err) => {
    log.warn(`voice-stream: twilio client error: ${err.message}`);
    dgClient.close();
  });
}

// ---------------------------------------------------------------------------
// Browser stream handler
// ---------------------------------------------------------------------------

function handleBrowserStream(
  clientWs: WebSocket,
  dgClient: DeepgramVoiceAgentClient,
  log: SubsystemLogger,
): void {
  clientWs.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) {
      // Binary frames are raw linear16 PCM audio
      const audioBuffer = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data);
      dgClient.sendAudio(audioBuffer);
      return;
    }

    // Text frames are JSON control messages
    try {
      const raw = Buffer.isBuffer(data)
        ? data.toString()
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString()
          : Buffer.concat(data).toString();
      const msg = JSON.parse(raw) as { type?: string };

      if (msg.type === "stop") {
        log.info("voice-stream: browser sent stop");
        dgClient.close();
      }
    } catch {
      // Not valid JSON, ignore
    }
  });

  // Deepgram audio → binary frame to control plane
  dgClient.on("audio", (audio: Buffer) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(audio);
    }
  });

  // Barge-in: send clear control frame
  dgClient.on("userStartedSpeaking", () => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "clear" }));
    }
  });

  // Conversation text → transcript frame
  dgClient.on("conversationText", (role: string, content: string) => {
    log.info(`voice-stream: [${role}] ${content.substring(0, 80)}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "transcript", role, content }));
    }
  });

  dgClient.on("error", (error: Error) => {
    log.warn(`voice-stream: deepgram error: ${error.message}`);
  });

  dgClient.on("closed", (code: number, reason: string) => {
    log.info(`voice-stream: deepgram closed (${code}): ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1000, "Deepgram closed");
    }
  });

  clientWs.on("close", () => {
    log.info("voice-stream: browser client disconnected");
    dgClient.close();
  });

  clientWs.on("error", (err) => {
    log.warn(`voice-stream: browser client error: ${err.message}`);
    dgClient.close();
  });
}

// ---------------------------------------------------------------------------
// Upgrade handler
// ---------------------------------------------------------------------------

export type VoiceStreamUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
) => boolean;

export function createVoiceStreamUpgradeHandler(opts: {
  log: SubsystemLogger;
}): VoiceStreamUpgradeHandler {
  const { log } = opts;

  return (req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): boolean => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname !== VOICE_STREAM_PATH) {
      return false;
    }

    const apiKey = resolveDeepgramApiKey();
    if (!apiKey) {
      log.warn("voice-stream: DEEPGRAM_API_KEY not configured");
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return true;
    }

    // Read control-plane headers
    const streamFormat = (getHeader(req, "x-deepclaw-stream-format") ?? "twilio") as StreamFormat;
    const userId = getHeader(req, "x-deepclaw-user-id");
    const callSid = getHeader(req, "x-deepclaw-call-sid");
    const phoneNumber = getHeader(req, "x-deepclaw-phone-number");

    log.info(
      `voice-stream: upgrade (format=${streamFormat}, userId=${userId}, callSid=${callSid})`,
    );

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      log.info("voice-stream: client connected");

      // Determine audio encoding/sample rate based on format
      let inputEncoding: DeepgramAudioEncoding;
      let inputSampleRate: number;
      let outputEncoding: DeepgramOutputEncoding;
      let outputSampleRate: number;

      if (streamFormat === "browser") {
        inputEncoding = "linear16";
        inputSampleRate = 16000;
        outputEncoding = "linear16";
        outputSampleRate = 16000;
      } else {
        // Twilio: mulaw at 8kHz
        inputEncoding = "mulaw";
        inputSampleRate = 8000;
        outputEncoding = "mulaw";
        outputSampleRate = 8000;
      }

      // Build LLM endpoint configuration
      const llmEndpoint = resolveLlmEndpoint();
      if (llmEndpoint && callSid) {
        // Add per-call session headers for gateway routing
        llmEndpoint.headers["x-openclaw-session-key"] = `agent:main:voice:${callSid}`;
        llmEndpoint.headers["x-openclaw-agent-id"] = "main";
      }

      const config: DeepgramVoiceAgentConfig = {
        apiKey,
        sttModel: "nova-3",
        ttsModel: "aura-2-thalia-en",
        language: "en",
        inputEncoding,
        inputSampleRate,
        outputEncoding,
        outputSampleRate,
        llmProvider: "open_ai",
        llmEndpoint,
        systemPrompt: buildSystemPrompt({ userId, phoneNumber, callSid }),
        maxReconnectAttempts: 0, // Don't reconnect — if Deepgram drops, the call is over
      };

      const dgClient = new DeepgramVoiceAgentClient(config);

      // Wire up format-specific handler before connecting
      if (streamFormat === "browser") {
        handleBrowserStream(clientWs, dgClient, log);
      } else {
        handleTwilioStream(clientWs, dgClient, log);
      }

      // Connect to Deepgram
      dgClient.connect().catch((err) => {
        log.warn(`voice-stream: failed to connect to Deepgram: ${String(err)}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1011, "Deepgram connection failed");
        }
      });
    });

    return true;
  };
}

export { VOICE_STREAM_PATH };
