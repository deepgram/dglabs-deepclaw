import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import { WebSocket } from "ws";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v2/listen";
const DICTATION_PATH = "/dictation/stream";

type DictationParams = {
  model?: string;
  language?: string;
  sampleRate?: string;
};

function buildDeepgramUrl(params: DictationParams): string {
  const url = new URL(DEEPGRAM_WS_URL);
  url.searchParams.set("model", params.model || "flux-general-en");
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", params.sampleRate || "16000");
  // v2/listen only accepts: model, encoding, sample_rate, eot_threshold, eager_eot_threshold, eot_timeout_ms
  // Do NOT set: interim_results, punctuate, smart_format, language (these are v1-only)
  return url.toString();
}

function resolveDeepgramApiKey(): string | null {
  const envResult = resolveEnvApiKey("deepgram");
  return envResult?.apiKey ?? null;
}

function isJsonMessage(data: Buffer | ArrayBuffer | Buffer[]): boolean {
  if (Buffer.isBuffer(data)) {
    // 0x7b is ASCII code for '{' - indicates start of JSON
    return data.length > 0 && data[0] === 0x7b;
  }
  if (data instanceof ArrayBuffer) {
    const view = new Uint8Array(data);
    return view.length > 0 && view[0] === 0x7b;
  }
  if (Array.isArray(data) && data.length > 0) {
    return isJsonMessage(data[0]);
  }
  return false;
}

export type DictationUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
) => boolean;

export function createDictationUpgradeHandler(opts: {
  log: SubsystemLogger;
}): DictationUpgradeHandler {
  const { log } = opts;

  return (req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): boolean => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname !== DICTATION_PATH) {
      return false;
    }

    const apiKey = resolveDeepgramApiKey();
    if (!apiKey) {
      log.warn("dictation: DEEPGRAM_API_KEY not configured");
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return true;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      log.info("dictation: client connected");

      const params: DictationParams = {
        model: reqUrl.searchParams.get("model") ?? undefined,
        language: reqUrl.searchParams.get("language") ?? undefined,
        sampleRate: reqUrl.searchParams.get("sample_rate") ?? undefined,
      };

      const deepgramUrl = buildDeepgramUrl(params);
      log.info(`dictation: connecting to ${deepgramUrl}`);
      const deepgramWs = new WebSocket(deepgramUrl, {
        headers: {
          Authorization: `Token ${apiKey}`,
        },
      });

      let deepgramReady = false;
      const pendingAudio: Buffer[] = [];
      let pendingBytes = 0;
      const MAX_PENDING_BYTES = 256 * 1024; // 256 KB (~8s of 16kHz mono PCM)
      const CONNECT_TIMEOUT_MS = 10_000;

      // Close client if Deepgram doesn't connect in time
      const connectTimer = setTimeout(() => {
        if (!deepgramReady) {
          log.error("dictation: Deepgram connection timeout");
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({ type: "Error", message: "Transcription service timeout" }),
            );
            clientWs.close(1011, "Deepgram connection timeout");
          }
          deepgramWs.close();
        }
      }, CONNECT_TIMEOUT_MS);

      deepgramWs.on("open", () => {
        clearTimeout(connectTimer);
        log.info("dictation: connected to Deepgram");
        deepgramReady = true;
        // Flush any pending audio
        for (const chunk of pendingAudio) {
          deepgramWs.send(chunk);
        }
        pendingAudio.length = 0;
        pendingBytes = 0;
      });

      deepgramWs.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        // Forward Deepgram responses to client
        if (clientWs.readyState === WebSocket.OPEN) {
          const message = Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data).toString("utf8");
          clientWs.send(message);
        }
      });

      deepgramWs.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          log.error(`dictation: Deepgram rejected (${res.statusCode}): ${body}`);
        });
      });

      deepgramWs.on("error", (err: Error & { code?: string }) => {
        clearTimeout(connectTimer);
        log.error(`dictation: Deepgram error: ${err.message} (code: ${err.code ?? "none"})`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: "Error", message: "Transcription service error" }));
          clientWs.close(1011, "Deepgram error");
        }
      });

      deepgramWs.on("close", (code, reason) => {
        clearTimeout(connectTimer);
        log.info(`dictation: Deepgram closed (${code}): ${reason.toString()}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1000, "Deepgram closed");
        }
      });

      clientWs.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        // Handle control messages (JSON starting with '{')
        if (isJsonMessage(data)) {
          try {
            const dataStr = Buffer.isBuffer(data)
              ? data.toString()
              : data instanceof ArrayBuffer
                ? Buffer.from(data).toString()
                : Buffer.concat(data).toString();
            const msg = JSON.parse(dataStr) as { type?: string };
            if (msg.type === "CloseStream" || msg.type === "Finalize") {
              if (deepgramWs.readyState === WebSocket.OPEN) {
                deepgramWs.send(JSON.stringify(msg));
              }
              return;
            }
            if (msg.type === "KeepAlive") {
              if (deepgramWs.readyState === WebSocket.OPEN) {
                deepgramWs.send(JSON.stringify(msg));
              }
              return;
            }
          } catch {
            // Not valid JSON, treat as audio
          }
        }

        // Forward audio data to Deepgram
        const audioData = Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data);
        if (deepgramReady && deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(audioData);
        } else if (pendingBytes < MAX_PENDING_BYTES) {
          // Buffer audio until Deepgram is ready (capped to prevent memory growth)
          pendingAudio.push(audioData);
          pendingBytes += audioData.length;
        }
      });

      clientWs.on("close", () => {
        log.info("dictation: client disconnected");
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
          deepgramWs.close();
        }
      });

      clientWs.on("error", (err) => {
        log.error(`dictation: client error: ${err.message}`);
        deepgramWs.close();
      });
    });

    return true;
  };
}

export { DICTATION_PATH };
