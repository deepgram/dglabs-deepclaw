import crypto from "node:crypto";
import type { TwilioConfig, WebhookSecurityConfig } from "../config.js";
import type { MediaStreamHandler } from "../media-stream.js";
import type { TelephonyTtsProvider } from "../telephony-tts.js";
import type {
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";
import { chunkAudio } from "../telephony-audio.js";
import { escapeXml, mapVoiceToPolly } from "../voice-mapping.js";
import { twilioApiRequest } from "./twilio/api.js";
import { verifyTwilioProviderWebhook } from "./twilio/webhook.js";

/**
 * Twilio Voice API provider implementation.
 *
 * Uses Twilio Programmable Voice API with Media Streams for real-time
 * bidirectional audio streaming.
 *
 * @see https://www.twilio.com/docs/voice
 * @see https://www.twilio.com/docs/voice/media-streams
 */
export interface TwilioProviderOptions {
  /** Allow ngrok free tier compatibility mode (loopback only, less secure) */
  allowNgrokFreeTierLoopbackBypass?: boolean;
  /** Override public URL for signature verification */
  publicUrl?: string;
  /** Path for media stream WebSocket (e.g., /voice/stream) */
  streamPath?: string;
  /** Skip webhook signature verification (development only) */
  skipVerification?: boolean;
  /** Webhook security options (forwarded headers/allowlist) */
  webhookSecurity?: WebhookSecurityConfig;
  /** Proxy URL for Twilio telephony — when set, all API calls go through the proxy and webhook verification is skipped */
  proxyUrl?: string;
}

export class TwilioProvider implements VoiceCallProvider {
  readonly name = "twilio" as const;

  private readonly accountSid: string | undefined;
  private readonly authToken: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly proxyUrl: string | undefined;
  private readonly callWebhookUrls = new Map<string, string>();
  private readonly options: TwilioProviderOptions;

  /** Current public webhook URL (set when tunnel starts or from config) */
  private currentPublicUrl: string | null = null;

  /** Optional telephony TTS provider for streaming TTS */
  private ttsProvider: TelephonyTtsProvider | null = null;

  /** Optional media stream handler for sending audio */
  private mediaStreamHandler: MediaStreamHandler | null = null;

  /** Map of call SID to stream SID for media streams */
  private callStreamMap = new Map<string, string>();
  /** Per-call tokens for media stream authentication */
  private streamAuthTokens = new Map<string, string>();

  /** Storage for TwiML content (for notify mode with URL-based TwiML) */
  private readonly twimlStorage = new Map<string, string>();
  /** Track notify-mode calls to avoid streaming on follow-up callbacks */
  private readonly notifyCalls = new Set<string>();

  private static shouldLogTwiml(): boolean {
    const raw = process.env.VOICE_CALL_TWIML_DEBUG?.trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  }

  private static summarizeTwiml(twiml: string): { bytes: number; hash: string; preview: string } {
    const bytes = Buffer.byteLength(twiml, "utf-8");
    const hash = crypto.createHash("sha256").update(twiml, "utf-8").digest("hex").slice(0, 12);

    // Redact anything that could include user content or auth tokens.
    let preview = twiml;
    preview = preview.replace(/(<Say\b[^>]*>)([\s\S]*?)(<\/Say>)/g, "$1[redacted]$3");
    preview = preview.replace(
      /(<Parameter\b[^>]*\bname="token"\b[^>]*\bvalue=")[^"]*(")/g,
      "$1[redacted]$2",
    );
    preview = preview.replace(/token=[^"&\s]+/g, "token=[redacted]");
    preview = preview.replace(/\s+/g, " ").trim();
    if (preview.length > 240) {
      preview = `${preview.slice(0, 240)}…`;
    }

    return { bytes, hash, preview };
  }

  private static logTwiml(details: {
    kind: string;
    twiml: string;
    callSid?: string;
    callStatus?: string | null;
    direction?: string | null;
    isStatusCallback: boolean;
    callIdFromQuery?: string;
    type?: string;
  }): void {
    if (!TwilioProvider.shouldLogTwiml()) {
      return;
    }
    const { bytes, hash, preview } = TwilioProvider.summarizeTwiml(details.twiml);
    console.log(
      `[voice-call] TwiML response kind=${details.kind} callSid=${details.callSid ?? "unknown"} callStatus=${details.callStatus ?? "unknown"} direction=${details.direction ?? "unknown"} isStatusCallback=${details.isStatusCallback} type=${details.type ?? "unknown"} callIdFromQuery=${details.callIdFromQuery ?? "none"} bytes=${bytes} hash=${hash} preview="${preview}"`,
    );
  }

  /**
   * Delete stored TwiML for a given `callId`.
   *
   * We keep TwiML in-memory only long enough to satisfy the initial Twilio
   * webhook request (notify mode). Subsequent webhooks should not reuse it.
   */
  private deleteStoredTwiml(callId: string): void {
    this.twimlStorage.delete(callId);
    this.notifyCalls.delete(callId);
  }

  /**
   * Delete stored TwiML for a call, addressed by Twilio's provider call SID.
   *
   * This is used when we only have `providerCallId` (e.g. hangup).
   */
  private deleteStoredTwimlForProviderCall(providerCallId: string): void {
    const webhookUrl = this.callWebhookUrls.get(providerCallId);
    if (!webhookUrl) {
      return;
    }

    const callIdMatch = webhookUrl.match(/callId=([^&]+)/);
    if (!callIdMatch) {
      return;
    }

    this.deleteStoredTwiml(callIdMatch[1]);
    this.streamAuthTokens.delete(providerCallId);
  }

  constructor(config: TwilioConfig, options: TwilioProviderOptions = {}) {
    this.proxyUrl = options.proxyUrl;

    // In proxy mode, Twilio credentials are not required — the proxy handles
    // all direct Twilio API interaction and webhook signature verification.
    if (!this.proxyUrl) {
      if (!config.accountSid) {
        throw new Error("Twilio Account SID is required");
      }
      if (!config.authToken) {
        throw new Error("Twilio Auth Token is required");
      }
    }

    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.baseUrl = config.accountSid
      ? `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`
      : undefined;
    this.options = options;

    if (options.publicUrl) {
      this.currentPublicUrl = options.publicUrl;
    }
  }

  setPublicUrl(url: string): void {
    this.currentPublicUrl = url;
  }

  getPublicUrl(): string | null {
    return this.currentPublicUrl;
  }

  setTTSProvider(provider: TelephonyTtsProvider): void {
    this.ttsProvider = provider;
  }

  setMediaStreamHandler(handler: MediaStreamHandler): void {
    this.mediaStreamHandler = handler;
  }

  registerCallStream(callSid: string, streamSid: string): void {
    this.callStreamMap.set(callSid, streamSid);
  }

  unregisterCallStream(callSid: string): void {
    this.callStreamMap.delete(callSid);
  }

  isValidStreamToken(callSid: string, token?: string): boolean {
    const expected = this.streamAuthTokens.get(callSid);
    if (!expected || !token) {
      return false;
    }
    if (expected.length !== token.length) {
      const dummy = Buffer.from(expected);
      crypto.timingSafeEqual(dummy, dummy);
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  }

  /**
   * Clear TTS queue for a call (barge-in).
   * Used when user starts speaking to interrupt current TTS playback.
   */
  clearTtsQueue(callSid: string): void {
    const streamSid = this.callStreamMap.get(callSid);
    if (streamSid && this.mediaStreamHandler) {
      this.mediaStreamHandler.clearTtsQueue(streamSid);
    }
  }

  /**
   * Make an authenticated request to the Twilio API.
   * In proxy mode, routes the request through the proxy instead.
   */
  private async apiRequest<T = unknown>(
    endpoint: string,
    params: Record<string, string | string[]>,
    options?: { allowNotFound?: boolean },
  ): Promise<T> {
    if (this.proxyUrl) {
      return await this.proxyApiRequest<T>(endpoint, params, options);
    }

    return await twilioApiRequest<T>({
      baseUrl: this.baseUrl!,
      accountSid: this.accountSid!,
      authToken: this.authToken!,
      endpoint,
      body: params,
      allowNotFound: options?.allowNotFound,
    });
  }

  /**
   * Route a Twilio API request through the proxy.
   */
  private async proxyApiRequest<T = unknown>(
    endpoint: string,
    params: Record<string, string | string[]>,
    options?: { allowNotFound?: boolean },
  ): Promise<T> {
    const body = { endpoint, params };

    console.log(`[voice-call] Twilio API via proxy: ${endpoint}`);

    const response = await fetch(`${this.proxyUrl}/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (options?.allowNotFound && response.status === 404) {
        return undefined as T;
      }
      const errorText = await response.text();
      throw new Error(`Voice proxy error: ${response.status} ${errorText}`);
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  /**
   * Verify Twilio webhook signature using HMAC-SHA1.
   *
   * In proxy mode, verification is skipped — the proxy already verified
   * the original Twilio signature before forwarding.
   *
   * Handles reverse proxy scenarios (Tailscale, nginx, ngrok) by reconstructing
   * the public URL from forwarding headers.
   *
   * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    if (this.proxyUrl) {
      console.log("[voice-call] webhook verification skipped (proxy mode)");
      return { ok: true };
    }

    return verifyTwilioProviderWebhook({
      ctx,
      authToken: this.authToken!,
      currentPublicUrl: this.currentPublicUrl,
      options: this.options,
    });
  }

  /**
   * Parse Twilio webhook event into normalized format.
   */
  parseWebhookEvent(ctx: WebhookContext): ProviderWebhookParseResult {
    try {
      const params = new URLSearchParams(ctx.rawBody);
      const callIdFromQuery =
        typeof ctx.query?.callId === "string" && ctx.query.callId.trim()
          ? ctx.query.callId.trim()
          : undefined;
      const event = this.normalizeEvent(params, callIdFromQuery);

      // For Twilio, we must return TwiML. Most actions are driven by Calls API updates,
      // so the webhook response is typically a pause to keep the call alive.
      const twiml = this.generateTwimlResponse(ctx);

      return {
        events: event ? [event] : [],
        providerResponseBody: twiml,
        providerResponseHeaders: { "Content-Type": "application/xml" },
        statusCode: 200,
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  /**
   * Parse Twilio direction to normalized format.
   */
  private static parseDirection(direction: string | null): "inbound" | "outbound" | undefined {
    if (direction === "inbound") {
      return "inbound";
    }
    if (direction === "outbound-api" || direction === "outbound-dial") {
      return "outbound";
    }
    return undefined;
  }

  /**
   * Convert Twilio webhook params to normalized event format.
   */
  private normalizeEvent(params: URLSearchParams, callIdOverride?: string): NormalizedEvent | null {
    const callSid = params.get("CallSid") || "";

    const baseEvent = {
      id: crypto.randomUUID(),
      callId: callIdOverride || callSid,
      providerCallId: callSid,
      timestamp: Date.now(),
      direction: TwilioProvider.parseDirection(params.get("Direction")),
      from: params.get("From") || undefined,
      to: params.get("To") || undefined,
    };

    // Handle speech result (from <Gather>)
    const speechResult = params.get("SpeechResult");
    if (speechResult) {
      return {
        ...baseEvent,
        type: "call.speech",
        transcript: speechResult,
        isFinal: true,
        confidence: parseFloat(params.get("Confidence") || "0.9"),
      };
    }

    // Handle DTMF
    const digits = params.get("Digits");
    if (digits) {
      return { ...baseEvent, type: "call.dtmf", digits };
    }

    // Handle call status changes
    const callStatus = params.get("CallStatus");
    switch (callStatus) {
      case "initiated":
        return { ...baseEvent, type: "call.initiated" };
      case "ringing":
        return { ...baseEvent, type: "call.ringing" };
      case "in-progress":
        return { ...baseEvent, type: "call.answered" };
      case "completed":
      case "busy":
      case "no-answer":
      case "failed":
        this.streamAuthTokens.delete(callSid);
        if (callIdOverride) {
          this.deleteStoredTwiml(callIdOverride);
        }
        return { ...baseEvent, type: "call.ended", reason: callStatus };
      case "canceled":
        this.streamAuthTokens.delete(callSid);
        if (callIdOverride) {
          this.deleteStoredTwiml(callIdOverride);
        }
        return { ...baseEvent, type: "call.ended", reason: "hangup-bot" };
      default:
        return null;
    }
  }

  private static readonly EMPTY_TWIML =
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

  private static readonly PAUSE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="30"/>
</Response>`;

  /**
   * Generate TwiML response for webhook.
   * When a call is answered, connects to media stream for bidirectional audio.
   */
  private generateTwimlResponse(ctx?: WebhookContext): string {
    if (!ctx) {
      const twiml = TwilioProvider.EMPTY_TWIML;
      TwilioProvider.logTwiml({
        kind: "no-context-empty",
        twiml,
        isStatusCallback: false,
      });
      return twiml;
    }

    const params = new URLSearchParams(ctx.rawBody);
    const type = typeof ctx.query?.type === "string" ? ctx.query.type.trim() : undefined;
    const isStatusCallback = type === "status";
    const callStatus = params.get("CallStatus");
    const direction = params.get("Direction");
    const isOutbound = direction?.startsWith("outbound") ?? false;
    const callSid = params.get("CallSid") || undefined;
    const callIdFromQuery =
      typeof ctx.query?.callId === "string" && ctx.query.callId.trim()
        ? ctx.query.callId.trim()
        : undefined;

    // Avoid logging webhook params/TwiML by default (may contain PII).
    // If VOICE_CALL_TWIML_DEBUG=1, we log a redacted + truncated TwiML preview
    // and a hash for correlation without printing user content or tokens.

    // Handle initial TwiML request (when Twilio first initiates the call)
    // Check if we have stored TwiML for this call (notify mode)
    if (callIdFromQuery && !isStatusCallback) {
      const storedTwiml = this.twimlStorage.get(callIdFromQuery);
      if (storedTwiml) {
        // Clean up after serving (one-time use)
        this.deleteStoredTwiml(callIdFromQuery);
        TwilioProvider.logTwiml({
          kind: "stored-notify-twiml",
          twiml: storedTwiml,
          callSid,
          callStatus,
          direction,
          isStatusCallback,
          type,
          callIdFromQuery,
        });
        return storedTwiml;
      }
      if (this.notifyCalls.has(callIdFromQuery)) {
        const twiml = TwilioProvider.EMPTY_TWIML;
        TwilioProvider.logTwiml({
          kind: "notify-followup-empty",
          twiml,
          callSid,
          callStatus,
          direction,
          isStatusCallback,
          type,
          callIdFromQuery,
        });
        return twiml;
      }

      // Conversation mode: return streaming TwiML immediately for outbound calls.
      if (isOutbound) {
        const streamInfo = callSid ? this.getStreamUrlForCall(callSid) : null;
        const twiml = streamInfo
          ? this.getStreamConnectXml(streamInfo.url, streamInfo.token)
          : TwilioProvider.PAUSE_TWIML;
        TwilioProvider.logTwiml({
          kind: streamInfo ? "outbound-initial-stream-connect" : "outbound-initial-pause",
          twiml,
          callSid,
          callStatus,
          direction,
          isStatusCallback,
          type,
          callIdFromQuery,
        });
        return twiml;
      }
    }

    // Status callbacks should not receive TwiML.
    if (isStatusCallback) {
      const twiml = TwilioProvider.EMPTY_TWIML;
      TwilioProvider.logTwiml({
        kind: "status-callback-empty",
        twiml,
        callSid,
        callStatus,
        direction,
        isStatusCallback,
        type,
        callIdFromQuery,
      });
      return twiml;
    }

    // Handle subsequent webhook requests (status callbacks, etc.)
    // For inbound calls, answer immediately with stream
    if (direction === "inbound") {
      const streamInfo = callSid ? this.getStreamUrlForCall(callSid) : null;
      const twiml = streamInfo
        ? this.getStreamConnectXml(streamInfo.url, streamInfo.token)
        : TwilioProvider.PAUSE_TWIML;
      TwilioProvider.logTwiml({
        kind: streamInfo ? "inbound-stream-connect" : "inbound-pause",
        twiml,
        callSid,
        callStatus,
        direction,
        isStatusCallback,
        type,
        callIdFromQuery,
      });
      return twiml;
    }

    // For outbound calls, only connect to stream when call is in-progress
    if (callStatus !== "in-progress") {
      const twiml = TwilioProvider.EMPTY_TWIML;
      TwilioProvider.logTwiml({
        kind: "outbound-not-in-progress-empty",
        twiml,
        callSid,
        callStatus,
        direction,
        isStatusCallback,
        type,
        callIdFromQuery,
      });
      return twiml;
    }

    const streamInfo = callSid ? this.getStreamUrlForCall(callSid) : null;
    const twiml = streamInfo
      ? this.getStreamConnectXml(streamInfo.url, streamInfo.token)
      : TwilioProvider.PAUSE_TWIML;
    TwilioProvider.logTwiml({
      kind: streamInfo ? "outbound-in-progress-stream-connect" : "outbound-in-progress-pause",
      twiml,
      callSid,
      callStatus,
      direction,
      isStatusCallback,
      type,
      callIdFromQuery,
    });
    return twiml;
  }

  /**
   * Get the WebSocket URL for media streaming.
   * Derives from the public URL origin + stream path.
   */
  private getStreamUrl(): string | null {
    if (!this.currentPublicUrl || !this.options.streamPath) {
      return null;
    }

    // Extract just the origin (host) from the public URL, ignoring any path
    const url = new URL(this.currentPublicUrl);
    const origin = url.origin;

    // Convert https:// to wss:// for WebSocket
    const wsOrigin = origin.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

    // Append the stream path
    const path = this.options.streamPath.startsWith("/")
      ? this.options.streamPath
      : `/${this.options.streamPath}`;

    return `${wsOrigin}${path}`;
  }

  private getStreamAuthToken(callSid: string): string {
    const existing = this.streamAuthTokens.get(callSid);
    if (existing) {
      return existing;
    }
    const token = crypto.randomBytes(16).toString("base64url");
    this.streamAuthTokens.set(callSid, token);
    return token;
  }

  private getStreamUrlForCall(callSid: string): { url: string; token: string } | null {
    const baseUrl = this.getStreamUrl();
    if (!baseUrl) {
      return null;
    }
    const token = this.getStreamAuthToken(callSid);
    return { url: baseUrl, token };
  }

  /**
   * Generate TwiML to connect a call to a WebSocket media stream.
   * This enables bidirectional audio streaming for real-time STT/TTS.
   *
   * @param streamUrl - WebSocket URL (wss://...) for the media stream
   */
  getStreamConnectXml(streamUrl: string, token?: string): string {
    const paramXml = token ? `\n      <Parameter name="token" value="${escapeXml(token)}" />` : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}">${paramXml}
    </Stream>
  </Connect>
</Response>`;
  }

  /**
   * Initiate an outbound call via Twilio API.
   * If inlineTwiml is provided, uses that directly (for notify mode).
   * Otherwise, uses webhook URL for dynamic TwiML.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = new URL(input.webhookUrl);
    url.searchParams.set("callId", input.callId);

    // Create separate URL for status callbacks (required by Twilio)
    const statusUrl = new URL(input.webhookUrl);
    statusUrl.searchParams.set("callId", input.callId);
    statusUrl.searchParams.set("type", "status"); // Differentiate from TwiML requests

    // Store TwiML content if provided (for notify mode)
    // We now serve it from the webhook endpoint instead of sending inline
    if (input.inlineTwiml) {
      this.twimlStorage.set(input.callId, input.inlineTwiml);
      this.notifyCalls.add(input.callId);
      if (TwilioProvider.shouldLogTwiml()) {
        const { bytes, hash, preview } = TwilioProvider.summarizeTwiml(input.inlineTwiml);
        console.log(
          `[voice-call] Stored notify TwiML callId=${input.callId} bytes=${bytes} hash=${hash} preview="${preview}"`,
        );
      }
    }

    // Build request params - always use URL-based TwiML.
    // Twilio silently ignores `StatusCallback` when using the inline `Twiml` parameter.
    const params: Record<string, string | string[]> = {
      To: input.to,
      From: input.from,
      Url: url.toString(), // TwiML serving endpoint
      StatusCallback: statusUrl.toString(), // Separate status callback endpoint
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "30",
    };
    if (TwilioProvider.shouldLogTwiml()) {
      console.log(
        `[voice-call] Twilio outbound call request callId=${input.callId} twimlUrl="${url.toString()}" statusCallbackUrl="${statusUrl.toString()}"`,
      );
    }

    const result = await this.apiRequest<TwilioCallResponse>("/Calls.json", params);

    this.callWebhookUrls.set(result.sid, url.toString());

    return {
      providerCallId: result.sid,
      status: result.status === "queued" ? "queued" : "initiated",
    };
  }

  /**
   * Hang up a call via Twilio API.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    this.deleteStoredTwimlForProviderCall(input.providerCallId);

    this.callWebhookUrls.delete(input.providerCallId);
    this.streamAuthTokens.delete(input.providerCallId);

    await this.apiRequest(
      `/Calls/${input.providerCallId}.json`,
      { Status: "completed" },
      { allowNotFound: true },
    );
  }

  /**
   * Play TTS audio via Twilio.
   *
   * Two modes:
   * 1. Core TTS + Media Streams: If TTS provider and media stream are available,
   *    generates audio via core TTS and streams it through WebSocket (preferred).
   * 2. TwiML <Say>: Falls back to Twilio's native TTS with Polly voices.
   *    Note: This may not work on all Twilio accounts.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    // Try telephony TTS via media stream first (if configured)
    const streamSid = this.callStreamMap.get(input.providerCallId);
    if (this.ttsProvider && this.mediaStreamHandler && streamSid) {
      try {
        await this.playTtsViaStream(input.text, streamSid);
        return;
      } catch (err) {
        console.warn(
          `[voice-call] Telephony TTS failed, falling back to Twilio <Say>:`,
          err instanceof Error ? err.message : err,
        );
        // Fall through to TwiML <Say> fallback
      }
    }

    // Fall back to TwiML <Say> (may not work on all accounts)
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call (provider state not initialized)");
    }

    console.warn(
      "[voice-call] Using TwiML <Say> fallback - telephony TTS not configured or media stream not active",
    );

    const pollyVoice = mapVoiceToPolly(input.voice);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${pollyVoice}" language="${input.locale || "en-US"}">${escapeXml(input.text)}</Say>
  <Gather input="speech" speechTimeout="auto" action="${escapeXml(webhookUrl)}" method="POST">
    <Say>.</Say>
  </Gather>
</Response>`;

    await this.apiRequest(`/Calls/${input.providerCallId}.json`, {
      Twiml: twiml,
    });
  }

  /**
   * Play TTS via core TTS and Twilio Media Streams.
   * Generates audio with core TTS, converts to mu-law, and streams via WebSocket.
   * Uses a queue to serialize playback and prevent overlapping audio.
   */
  private async playTtsViaStream(text: string, streamSid: string): Promise<void> {
    if (!this.ttsProvider || !this.mediaStreamHandler) {
      throw new Error("TTS provider and media stream handler required");
    }

    // Stream audio in 20ms chunks (160 bytes at 8kHz mu-law)
    const CHUNK_SIZE = 160;
    const CHUNK_DELAY_MS = 20;

    const handler = this.mediaStreamHandler;
    const ttsProvider = this.ttsProvider;
    await handler.queueTts(streamSid, async (signal) => {
      // Generate audio with core TTS (returns mu-law at 8kHz)
      const muLawAudio = await ttsProvider.synthesizeForTelephony(text);
      for (const chunk of chunkAudio(muLawAudio, CHUNK_SIZE)) {
        if (signal.aborted) {
          break;
        }
        handler.sendAudio(streamSid, chunk);

        // Pace the audio to match real-time playback
        await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
        if (signal.aborted) {
          break;
        }
      }

      if (!signal.aborted) {
        // Send a mark to track when audio finishes
        handler.sendMark(streamSid, `tts-${Date.now()}`);
      }
    });
  }

  /**
   * Start listening for speech via Twilio <Gather>.
   */
  async startListening(input: StartListeningInput): Promise<void> {
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call (provider state not initialized)");
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" language="${input.language || "en-US"}" action="${escapeXml(webhookUrl)}" method="POST">
  </Gather>
</Response>`;

    await this.apiRequest(`/Calls/${input.providerCallId}.json`, {
      Twiml: twiml,
    });
  }

  /**
   * Stop listening - for Twilio this is a no-op as <Gather> auto-ends.
   */
  async stopListening(_input: StopListeningInput): Promise<void> {
    // Twilio's <Gather> automatically stops on speech end
    // No explicit action needed
  }
}

// -----------------------------------------------------------------------------
// Twilio-specific types
// -----------------------------------------------------------------------------

interface TwilioCallResponse {
  sid: string;
  status: string;
  direction: string;
  from: string;
  to: string;
  uri: string;
}
