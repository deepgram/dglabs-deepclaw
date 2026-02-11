import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { DeepgramMediaBridge } from "./deepgram-media-bridge.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { DeepgramProvider } from "./providers/deepgram.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";
import { generateFillerSet } from "./filler.js";
import { MediaStreamHandler } from "./media-stream.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const BROWSER_VOICE_PATH = "/voice/web";

/**
 * HTTP server for receiving voice call webhooks from providers.
 * Supports WebSocket upgrades for media streams when streaming is enabled.
 */
export class VoiceCallWebhookServer {
  private server: http.Server | null = null;
  private config: VoiceCallConfig;
  private manager: CallManager;
  private provider: VoiceCallProvider;
  private coreConfig: CoreConfig | null;

  /** Media stream handler for bidirectional audio (when streaming enabled) */
  private mediaStreamHandler: MediaStreamHandler | null = null;
  /** Deepgram media bridge for hybrid mode */
  private deepgramBridge: DeepgramMediaBridge | null = null;
  /** DeepgramProvider for browser voice in hybrid mode */
  private hybridDeepgramProvider: DeepgramProvider | null = null;
  /** WebSocket server for browser voice connections */
  private browserVoiceWss: WebSocketServer | null = null;
  /** Gateway URL for LLM proxy */
  private gatewayUrl: string | null = null;
  /** Gateway auth token */
  private gatewayToken: string | null = null;
  /** Filler threshold (ms) — inject filler phrase if first SSE chunk takes longer */
  private fillerThresholdMs: number = 0;
  /** Filler phrases to randomly pick from when threshold fires */
  private fillerPhrases: string[] = [];
  /** Whether to generate dynamic filler phrases via Haiku */
  private dynamicFiller: boolean = true;

  constructor(
    config: VoiceCallConfig,
    manager: CallManager,
    provider: VoiceCallProvider,
    coreConfig?: CoreConfig,
  ) {
    this.config = config;
    this.manager = manager;
    this.provider = provider;
    this.coreConfig = coreConfig ?? null;

    // Store filler config from deepgram latency settings
    if (config.deepgram?.latency) {
      this.fillerThresholdMs = config.deepgram.latency.fillerThresholdMs ?? 0;
      this.fillerPhrases = config.deepgram.latency.fillerPhrases ?? [];
      this.dynamicFiller = config.deepgram.latency.dynamicFiller ?? true;
    }

    // Initialize media stream handler if streaming is enabled
    if (config.streaming?.enabled) {
      this.initializeMediaStreaming();
    }
  }

  /**
   * Get the media stream handler (for wiring to provider).
   */
  getMediaStreamHandler(): MediaStreamHandler | null {
    return this.mediaStreamHandler;
  }

  /**
   * Set the Deepgram media bridge for hybrid mode WS routing.
   *
   * @param bridge - The bridge handling Twilio media stream ↔ Deepgram
   * @param deepgramProvider - DeepgramProvider for browser voice sessions
   */
  setDeepgramMediaBridge(bridge: DeepgramMediaBridge, deepgramProvider?: DeepgramProvider): void {
    this.deepgramBridge = bridge;
    if (deepgramProvider) {
      this.hybridDeepgramProvider = deepgramProvider;
    }
  }

  /**
   * Configure gateway proxy settings.
   */
  setGatewayConfig(url: string, token: string): void {
    this.gatewayUrl = url;
    this.gatewayToken = token;
  }

  /**
   * Initialize media streaming with OpenAI Realtime STT.
   */
  private initializeMediaStreaming(): void {
    const apiKey = this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.warn("[voice-call] Streaming enabled but no OpenAI API key found");
      return;
    }

    const sttProvider = new OpenAIRealtimeSTTProvider({
      apiKey,
      model: this.config.streaming?.sttModel,
      silenceDurationMs: this.config.streaming?.silenceDurationMs,
      vadThreshold: this.config.streaming?.vadThreshold,
    });

    const streamConfig: MediaStreamConfig = {
      sttProvider,
      shouldAcceptStream: ({ callId, token }) => {
        const call = this.manager.getCallByProviderCallId(callId);
        if (!call) {
          return false;
        }
        if (this.provider.name === "twilio") {
          const twilio = this.provider as TwilioProvider;
          if (!twilio.isValidStreamToken(callId, token)) {
            console.warn(`[voice-call] Rejecting media stream: invalid token for ${callId}`);
            return false;
          }
        }
        return true;
      },
      onTranscript: (providerCallId, transcript) => {
        console.log(`[voice-call] Transcript for ${providerCallId}: ${transcript}`);

        // Clear TTS queue on barge-in (user started speaking, interrupt current playback)
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }

        // Look up our internal call ID from the provider call ID
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (!call) {
          console.warn(`[voice-call] No active call found for provider ID: ${providerCallId}`);
          return;
        }

        // Create a speech event and process it through the manager
        const event: NormalizedEvent = {
          id: `stream-transcript-${Date.now()}`,
          type: "call.speech",
          callId: call.callId,
          providerCallId,
          timestamp: Date.now(),
          transcript,
          isFinal: true,
        };
        this.manager.processEvent(event);

        // Auto-respond in conversation mode (inbound always, outbound if mode is conversation)
        const callMode = call.metadata?.mode as string | undefined;
        const shouldRespond = call.direction === "inbound" || callMode === "conversation";
        if (shouldRespond) {
          this.handleInboundResponse(call.callId, transcript).catch((err) => {
            console.warn(`[voice-call] Failed to auto-respond:`, err);
          });
        }
      },
      onSpeechStart: (providerCallId) => {
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }
      },
      onPartialTranscript: (callId, partial) => {
        console.log(`[voice-call] Partial for ${callId}: ${partial}`);
      },
      onConnect: (callId, streamSid) => {
        console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
        // Register stream with provider for TTS routing
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).registerCallStream(callId, streamSid);
        }

        // Speak initial message if one was provided when call was initiated
        // Use setTimeout to allow stream setup to complete
        setTimeout(() => {
          this.manager.speakInitialMessage(callId).catch((err) => {
            console.warn(`[voice-call] Failed to speak initial message:`, err);
          });
        }, 500);
      },
      onDisconnect: (callId) => {
        console.log(`[voice-call] Media stream disconnected: ${callId}`);
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).unregisterCallStream(callId);
        }
      },
    };

    this.mediaStreamHandler = new MediaStreamHandler(streamConfig);
    console.log("[voice-call] Media streaming initialized");
  }

  /**
   * Start the webhook server.
   */
  async start(): Promise<string> {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.streaming?.streamPath || "/voice/stream";

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res, webhookPath).catch((err) => {
          console.error("[voice-call] Webhook error:", err);
          res.statusCode = 500;
          res.end("Internal Server Error");
        });
      });

      // Handle WebSocket upgrades for media streams
      this.server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url || "/", `http://${request.headers.host}`);

        if (url.pathname === streamPath) {
          if (this.deepgramBridge) {
            console.log("[voice-call] WebSocket upgrade for Deepgram media bridge");
            this.deepgramBridge.handleUpgrade(request, socket, head);
          } else if (this.mediaStreamHandler) {
            console.log("[voice-call] WebSocket upgrade for media stream");
            this.mediaStreamHandler.handleUpgrade(request, socket, head);
          } else {
            socket.destroy();
          }
        } else if (
          url.pathname === BROWSER_VOICE_PATH &&
          (this.provider.name === "deepgram" || this.deepgramBridge)
        ) {
          this.handleBrowserVoiceUpgrade(request, socket, head, url);
        } else {
          socket.destroy();
        }
      });

      this.server.on("error", reject);

      this.server.listen(port, bind, () => {
        const url = `http://${bind}:${port}${webhookPath}`;
        console.log(`[voice-call] Webhook server listening on ${url}`);
        if (this.mediaStreamHandler) {
          console.log(`[voice-call] Media stream WebSocket on ws://${bind}:${port}${streamPath}`);
        }
        if (this.provider.name === "deepgram" || this.hybridDeepgramProvider) {
          console.log(
            `[voice-call] Browser voice WebSocket on ws://${bind}:${port}${BROWSER_VOICE_PATH}`,
          );
        }
        resolve(url);
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  async stop(): Promise<void> {
    if (this.browserVoiceWss) {
      this.browserVoiceWss.close();
      this.browserVoiceWss = null;
    }
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Browser Voice WebSocket
  // ---------------------------------------------------------------------------

  /**
   * Handle WebSocket upgrade for browser voice connections.
   * Creates a Deepgram Voice Agent session bridged to the browser.
   *
   * Protocol:
   *  - Client sends binary frames (PCM/linear16 audio from browser mic)
   *  - Server sends binary frames (synthesized audio from Deepgram TTS)
   *  - Client sends JSON text frames for control: { type: "close" }
   *  - Server sends JSON text frames for events:
   *    { type: "conversationText", role, content }
   *    { type: "agentStartedSpeaking" }
   *    { type: "userStartedSpeaking" }
   *    { type: "agentAudioDone" }
   *    { type: "error", message }
   *    { type: "connected" }
   */
  private handleBrowserVoiceUpgrade(
    request: http.IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
    url: URL,
  ): void {
    if (!this.browserVoiceWss) {
      this.browserVoiceWss = new WebSocketServer({ noServer: true });
    }

    this.browserVoiceWss.handleUpgrade(request, socket, head, (ws) => {
      void this.handleBrowserVoiceConnection(ws, url);
    });
  }

  private async handleBrowserVoiceConnection(ws: WebSocket, url: URL): Promise<void> {
    const token = url.searchParams.get("token") ?? undefined;

    // Basic token validation (if gateway token is set, require it)
    const expectedToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (expectedToken && token !== expectedToken) {
      console.warn("[voice-call] Browser voice connection rejected: invalid token");
      ws.close(1008, "Unauthorized");
      return;
    }

    // In direct Deepgram mode, provider IS the DeepgramProvider.
    // In hybrid mode, use the stored hybridDeepgramProvider.
    const dgProvider =
      this.provider.name === "deepgram"
        ? (this.provider as DeepgramProvider)
        : this.hybridDeepgramProvider;

    if (!dgProvider) {
      ws.close(1008, "Browser voice requires Deepgram provider");
      return;
    }
    const callId = `web-${crypto.randomUUID()}`;

    console.log(`[voice-call] Browser voice session started: ${callId}`);

    try {
      const client = await dgProvider.createSession(callId, callId);

      // Send connected event to browser
      this.sendBrowserEvent(ws, { type: "connected", callId });

      // Bridge: Deepgram audio → browser
      client.on("audio", (audio) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(audio);
        }
      });

      // Bridge: Deepgram events → browser
      client.on("conversationText", (role, content) => {
        this.sendBrowserEvent(ws, { type: "conversationText", role, content });
      });

      client.on("userStartedSpeaking", () => {
        this.sendBrowserEvent(ws, { type: "userStartedSpeaking" });
      });

      client.on("agentStartedSpeaking", () => {
        this.sendBrowserEvent(ws, { type: "agentStartedSpeaking" });
      });

      client.on("agentAudioDone", () => {
        this.sendBrowserEvent(ws, { type: "agentAudioDone" });
      });

      client.on("agentThinking", () => {
        this.sendBrowserEvent(ws, { type: "agentThinking" });
      });

      client.on("error", (error) => {
        this.sendBrowserEvent(ws, { type: "error", message: error.message });
      });

      // Bridge: browser audio → Deepgram
      ws.on("message", (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          // Binary data is audio from browser microphone
          const audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data as string, "binary");
          client.sendAudio(audioBuffer);
          return;
        }

        // Text frames are control messages
        try {
          const msg = JSON.parse(data.toString()) as { type: string };
          if (msg.type === "close") {
            client.close();
            ws.close(1000, "Client requested close");
          }
        } catch {
          // Ignore invalid JSON
        }
      });

      // Clean up on disconnect
      ws.on("close", () => {
        console.log(`[voice-call] Browser voice session ended: ${callId}`);
        dgProvider.closeSession(callId);
      });

      ws.on("error", (error) => {
        console.error(`[voice-call] Browser voice WebSocket error:`, error);
        dgProvider.closeSession(callId);
      });
    } catch (error) {
      console.error(`[voice-call] Failed to create browser voice session:`, error);
      this.sendBrowserEvent(ws, {
        type: "error",
        message: error instanceof Error ? error.message : "Failed to create session",
      });
      ws.close(1011, "Session creation failed");
    }
  }

  private sendBrowserEvent(ws: WebSocket, event: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Gateway LLM proxy for Deepgram think.endpoint
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      await this.handleGatewayProxy(req, res);
      return;
    }

    // Proxy non-voice webhook paths (e.g. /text/webhook) to the gateway HTTP server
    if (!url.pathname.startsWith(webhookPath) && url.pathname !== webhookPath) {
      console.log(`[voice-call] proxying ${req.method} ${url.pathname} to gateway`);
      await this.proxyToGateway(req, res);
      return;
    }

    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    // Read body
    let body = "";
    try {
      body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      if (err instanceof Error && err.message === "PayloadTooLarge") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }

    // Build webhook context
    const ctx: WebhookContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: body,
      url: `http://${req.headers.host}${req.url}`,
      method: "POST",
      query: Object.fromEntries(url.searchParams),
      remoteAddress: req.socket.remoteAddress ?? undefined,
    };

    // Verify signature
    const verification = this.provider.verifyWebhook(ctx);
    if (!verification.ok) {
      console.warn(`[voice-call] Webhook verification failed: ${verification.reason}`);
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    // Parse events
    const result = this.provider.parseWebhookEvent(ctx);

    // Process each event
    for (const event of result.events) {
      try {
        this.manager.processEvent(event);
      } catch (err) {
        console.error(`[voice-call] Error processing event ${event.type}:`, err);
      }
    }

    // Send response
    res.statusCode = result.statusCode || 200;

    if (result.providerResponseHeaders) {
      for (const [key, value] of Object.entries(result.providerResponseHeaders)) {
        res.setHeader(key, value);
      }
    }

    res.end(result.providerResponseBody || "OK");
  }

  /**
   * Read request body as string with timeout protection.
   */
  private readBody(
    req: http.IncomingMessage,
    maxBytes: number,
    timeoutMs = 30_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          const err = new Error("Request body timeout");
          req.destroy(err);
          reject(err);
        });
      }, timeoutMs);

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          finish(() => {
            req.destroy();
            reject(new Error("PayloadTooLarge"));
          });
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf-8"))));
      req.on("error", (err) => finish(() => reject(err)));
      req.on("close", () => finish(() => reject(new Error("Connection closed"))));
    });
  }

  /**
   * Handle auto-response for inbound calls using the agent system.
   * Supports tool calling for richer voice interactions.
   */
  private async handleInboundResponse(callId: string, userMessage: string): Promise<void> {
    console.log(`[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`);

    // Get call context for conversation history
    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      return;
    }

    if (!this.coreConfig) {
      console.warn("[voice-call] Core config missing; skipping auto-response");
      return;
    }

    try {
      const { generateVoiceResponse } = await import("./response-generator.js");

      const result = await generateVoiceResponse({
        voiceConfig: this.config,
        coreConfig: this.coreConfig,
        callId,
        from: call.from,
        calledNumber: call.to,
        transcript: call.transcript,
        userMessage,
      });

      if (result.error) {
        console.error(`[voice-call] Response generation error: ${result.error}`);
        return;
      }

      if (result.text) {
        console.log(`[voice-call] AI response: "${result.text}"`);
        await this.manager.speak(callId, result.text);
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
    }
  }

  /**
   * Proxy /v1/chat/completions requests to the gateway.
   * Used by Deepgram's think.endpoint to route LLM calls through the gateway.
   *
   * Supports SSE streaming: when the gateway returns `text/event-stream`,
   * chunks are piped through in real-time so Deepgram can begin TTS immediately.
   * If the first chunk takes longer than `fillerThresholdMs`, a filler phrase
   * is injected so the caller hears an acknowledgment instead of silence.
   */
  private async handleGatewayProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.gatewayUrl || !this.gatewayToken) {
      res.statusCode = 503;
      res.end("Gateway not configured");
      return;
    }

    let body: string;
    try {
      body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      if (err instanceof Error && err.message === "PayloadTooLarge") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }

    // Force streaming so the gateway uses its SSE path
    try {
      const parsedBody: Record<string, unknown> = JSON.parse(body);
      parsedBody.stream = true;
      body = JSON.stringify(parsedBody);
    } catch {
      /* keep original body if parse fails */
    }

    // Forward session key and agent ID from incoming headers
    const sessionKey = req.headers["x-openclaw-session-key"] as string | undefined;
    const agentId = req.headers["x-openclaw-agent-id"] as string | undefined;

    const proxyHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.gatewayToken}`,
    };
    if (sessionKey) proxyHeaders["x-openclaw-session-key"] = sessionKey;
    if (agentId) proxyHeaders["x-openclaw-agent-id"] = agentId;

    try {
      console.log(`[voice-call] Proxying /v1/chat/completions (streaming) to ${this.gatewayUrl}`);
      const proxyRes = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: proxyHeaders,
        body,
      });

      res.statusCode = proxyRes.status;
      const contentType = proxyRes.headers.get("content-type");
      if (contentType) res.setHeader("Content-Type", contentType);

      // SSE streaming — pipe chunks through in real-time
      if (contentType?.includes("text/event-stream") && proxyRes.body) {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        const reader = proxyRes.body.getReader();
        const proxyStartTime = Date.now();

        const threshold = this.fillerThresholdMs;
        const phrases = this.fillerPhrases;
        const FOLLOWUP_INTERVAL_MS = 5000;
        const STATIC_FOLLOWUPS = [
          "Still working on that.",
          "Almost there, one sec.",
          "Hang on, still pulling that up.",
          "Just a moment longer.",
        ];

        // Extract callSid from session key (agent:agentId:voice:callSid)
        const callSid = sessionKey?.split(":")[3];

        // Filler injection via Deepgram InjectAgentMessage (speaks immediately,
        // independent of SSE stream).
        let fillerCount = 0;
        let contentReceived = false;
        const timers: ReturnType<typeof setTimeout>[] = [];
        // Dynamic filler set (primary + follow-ups) generated by Haiku in one call
        let dynamicFillers: string[] | null = null;

        const injectFiller = (phrase: string, source: string): boolean => {
          if (contentReceived) return false;
          if (callSid && this.deepgramBridge?.injectFiller(callSid, phrase)) {
            fillerCount++;
            console.log(
              `[voice-call] Filler #${fillerCount} (${source}): "${phrase}" (+${Date.now() - proxyStartTime}ms)`,
            );
            return true;
          }
          return false;
        };

        const scheduleFollowups = () => {
          const jitter = Math.floor(Math.random() * 2000) - 1000; // ±1s
          const timer = setTimeout(() => {
            if (contentReceived) return;
            // Use dynamic follow-ups if available, otherwise static
            const phrase = dynamicFillers?.[fillerCount] ?? STATIC_FOLLOWUPS[fillerCount - 1];
            if (phrase) {
              injectFiller(phrase, dynamicFillers?.[fillerCount] ? "dynamic" : "static");
              if (fillerCount < 4) scheduleFollowups();
            }
          }, FOLLOWUP_INTERVAL_MS + jitter);
          timers.push(timer);
        };

        // Generate full filler set via Haiku (primary + follow-ups in one call)
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (this.dynamicFiller && anthropicKey && threshold > 0 && callSid) {
          let userMessage = "";
          try {
            const parsed = JSON.parse(body) as {
              messages?: Array<{ role: string; content: string }>;
            };
            const last = parsed.messages?.filter((m) => m.role === "user").pop();
            if (last?.content) userMessage = last.content;
          } catch {
            /* ignore parse errors */
          }
          if (userMessage) {
            void generateFillerSet({ userMessage }, anthropicKey).then((fillers) => {
              if (fillers && fillers.length > 0) {
                dynamicFillers = fillers;
                console.log(
                  `[voice-call] Dynamic fillers ready (${fillers.length}): ${fillers.map((f) => `"${f}"`).join(", ")} (+${Date.now() - proxyStartTime}ms)`,
                );
                if (fillerCount === 0) {
                  injectFiller(fillers[0], "dynamic");
                  scheduleFollowups();
                }
              }
            });
          }
        }

        // Fallback: static filler fires at threshold if dynamic hasn't arrived yet
        if (threshold > 0 && phrases.length > 0 && callSid) {
          timers.push(
            setTimeout(() => {
              if (fillerCount === 0) {
                const phrase = phrases[Math.floor(Math.random() * phrases.length)];
                if (phrase) {
                  injectFiller(phrase, "static");
                  scheduleFollowups();
                }
              }
            }, threshold),
          );
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!contentReceived) {
              const chunkText = new TextDecoder().decode(value, { stream: true });
              if (chunkText.includes('"content"')) {
                contentReceived = true;
                console.log(
                  `[voice-call] Content received (+${Date.now() - proxyStartTime}ms, fillers=${fillerCount})`,
                );
              }
            }
            res.write(value);
          }
        } finally {
          for (const t of timers) clearTimeout(t);
          res.end();
        }
      } else {
        // Non-streaming — buffer and forward
        const responseBody = await proxyRes.text();
        res.end(responseBody);
      }
    } catch (err) {
      console.error("[voice-call] Gateway proxy error:", err);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("Bad Gateway");
      } else {
        // Mid-stream error — write an SSE error event and close
        try {
          res.write(
            `data: ${JSON.stringify({
              error: { message: "Gateway proxy error", type: "proxy_error" },
            })}\n\n`,
          );
        } catch {
          /* response may already be closed */
        }
        res.end();
      }
    }
  }

  /**
   * Proxy non-voice HTTP requests to the gateway HTTP server.
   * Used for channel webhooks (e.g. /text/webhook for Twilio SMS) that arrive
   * on the voice-call port via ngrok.
   */
  private async proxyToGateway(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const gatewayBase =
      this.gatewayUrl?.replace(/\/v1\/chat\/completions$/, "").replace(/\/$/, "") ||
      "http://127.0.0.1:18789";

    let body: string;
    try {
      body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      if (err instanceof Error && err.message === "PayloadTooLarge") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }

    const targetUrl = `${gatewayBase}${req.url}`;
    console.log(`[voice-call] proxy target: ${targetUrl}`);
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value && typeof value === "string") {
        forwardHeaders[key] = value;
      }
    }
    // Ensure the gateway sees the original host/proto for signature verification
    if (!forwardHeaders["x-forwarded-host"] && req.headers.host) {
      forwardHeaders["x-forwarded-host"] = req.headers.host;
    }
    if (!forwardHeaders["x-forwarded-proto"]) {
      forwardHeaders["x-forwarded-proto"] = "https";
    }

    try {
      const proxyRes = await fetch(targetUrl, {
        method: req.method ?? "POST",
        headers: forwardHeaders,
        body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      });

      console.log(`[voice-call] proxy response: ${proxyRes.status} for ${req.url}`);
      res.statusCode = proxyRes.status;
      for (const [key, value] of proxyRes.headers.entries()) {
        res.setHeader(key, value);
      }
      const responseBody = await proxyRes.text();
      res.end(responseBody);
    } catch (err) {
      console.error("[voice-call] Gateway webhook proxy error:", err);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("Bad Gateway");
      }
    }
  }
}

/**
 * Resolve the current machine's Tailscale DNS name.
 */
export type TailscaleSelfInfo = {
  dnsName: string | null;
  nodeId: string | null;
};

/**
 * Run a tailscale command with timeout, collecting stdout.
 */
function runTailscaleCommand(
  args: string[],
  timeoutMs = 2500,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn("tailscale", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (data) => {
      stdout += data;
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ code: -1, stdout: "" });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

export async function getTailscaleSelfInfo(): Promise<TailscaleSelfInfo | null> {
  const { code, stdout } = await runTailscaleCommand(["status", "--json"]);
  if (code !== 0) {
    return null;
  }

  try {
    const status = JSON.parse(stdout);
    return {
      dnsName: status.Self?.DNSName?.replace(/\.$/, "") || null,
      nodeId: status.Self?.ID || null,
    };
  } catch {
    return null;
  }
}

export async function getTailscaleDnsName(): Promise<string | null> {
  const info = await getTailscaleSelfInfo();
  return info?.dnsName ?? null;
}

export async function setupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
  localUrl: string;
}): Promise<string | null> {
  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    console.warn("[voice-call] Could not get Tailscale DNS name");
    return null;
  }

  const { code } = await runTailscaleCommand([
    opts.mode,
    "--bg",
    "--yes",
    "--set-path",
    opts.path,
    opts.localUrl,
  ]);

  if (code === 0) {
    const publicUrl = `https://${dnsName}${opts.path}`;
    console.log(`[voice-call] Tailscale ${opts.mode} active: ${publicUrl}`);
    return publicUrl;
  }

  console.warn(`[voice-call] Tailscale ${opts.mode} failed`);
  return null;
}

export async function cleanupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
}): Promise<void> {
  await runTailscaleCommand([opts.mode, "off", opts.path]);
}

/**
 * Setup Tailscale serve/funnel for the webhook server.
 * This is a helper that shells out to `tailscale serve` or `tailscale funnel`.
 */
export async function setupTailscaleExposure(config: VoiceCallConfig): Promise<string | null> {
  if (config.tailscale.mode === "off") {
    return null;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  // Include the path suffix so tailscale forwards to the correct endpoint
  // (tailscale strips the mount path prefix when proxying)
  const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
  return setupTailscaleExposureRoute({
    mode,
    path: config.tailscale.path,
    localUrl,
  });
}

/**
 * Cleanup Tailscale serve/funnel.
 */
export async function cleanupTailscaleExposure(config: VoiceCallConfig): Promise<void> {
  if (config.tailscale.mode === "off") {
    return;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  await cleanupTailscaleExposureRoute({ mode, path: config.tailscale.path });
}
