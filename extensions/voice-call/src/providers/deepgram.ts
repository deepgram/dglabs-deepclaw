/**
 * Deepgram Voice Agent Provider
 *
 * Implements VoiceCallProvider by wrapping DeepgramVoiceAgentClient.
 * Unlike Twilio/Telnyx/Plivo which handle telephony + media separately,
 * Deepgram manages the full voice pipeline (STT → LLM → TTS) internally.
 *
 * This provider:
 * - Manages DeepgramVoiceAgentClient instances per active call
 * - Bridges audio between telephony (Twilio media streams) and Deepgram
 * - Translates Deepgram events into NormalizedEvent format
 * - Handles function calls from Deepgram by delegating to a callback
 */

import crypto from "node:crypto";
import type { DeepgramConfig } from "../config.js";
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
import { FallbackManager, type FallbackEvent } from "./deepgram-fallback.js";
import {
  DeepgramVoiceAgentClient,
  type DeepgramFunctionDef,
  type DeepgramVoiceAgentConfig,
} from "./deepgram-voice-agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeepgramSessionOverrides {
  systemPrompt?: string;
  llmProvider?: DeepgramVoiceAgentConfig["llmProvider"];
  llmEndpoint?: { url: string; headers?: Record<string, string> };
  greeting?: string;
}

export interface DeepgramProviderOptions {
  /** LLM provider for the think stage (default: "open_ai") */
  llmProvider?: DeepgramVoiceAgentConfig["llmProvider"];
  /** LLM model (default: "gpt-4o-mini") */
  llmModel?: string;
  /** Custom LLM endpoint (for self-hosted or custom providers) */
  llmEndpoint?: { url: string; headers?: Record<string, string> };
  /** System prompt for the agent */
  systemPrompt?: string;
  /** Greeting spoken when agent connects */
  greeting?: string;
  /** Client-side function definitions */
  functions?: DeepgramFunctionDef[];
  /**
   * Callback invoked when Deepgram requests a client-side function call.
   * Returns the result as a string.
   */
  onFunctionCall?: (name: string, args: Record<string, unknown>, callId: string) => Promise<string>;
  /** Callback invoked when an event is emitted for a call */
  onEvent?: (callId: string, event: NormalizedEvent) => void;
  /** Callback invoked when synthesized audio is received for a call */
  onAudio?: (callId: string, audio: Buffer) => void;
  /** Key terms for speech recognition boosting */
  keyterms?: string[];
  /** Callback invoked on fallback events (for observability/logging). */
  onFallbackEvent?: (event: FallbackEvent) => void;
}

interface ActiveSession {
  client: DeepgramVoiceAgentClient;
  callId: string;
  providerCallId: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DeepgramProvider implements VoiceCallProvider {
  readonly name = "deepgram" as const;

  private readonly apiKey: string;
  private readonly dgConfig: DeepgramConfig;
  private readonly options: DeepgramProviderOptions;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly fallback: FallbackManager;

  constructor(config: DeepgramConfig, options: DeepgramProviderOptions = {}) {
    if (!config.apiKey) {
      throw new Error("Deepgram API key is required");
    }
    this.apiKey = config.apiKey;
    this.dgConfig = config;
    this.options = options;
    this.fallback = new FallbackManager({
      config: config.fallback,
      onHangup: (callId) => this.closeSession(callId),
      onFallbackEvent: options.onFallbackEvent,
    });
  }

  // -----------------------------------------------------------------------
  // VoiceCallProvider interface
  // -----------------------------------------------------------------------

  /**
   * Deepgram voice agent uses WebSocket, not webhooks.
   * Always returns ok for compatibility with the provider interface.
   */
  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  /**
   * Deepgram events arrive via WebSocket, not HTTP webhooks.
   * This is a no-op for direct Deepgram mode; events are emitted through
   * the DeepgramVoiceAgentClient EventEmitter instead.
   */
  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [], statusCode: 200 };
  }

  /**
   * Create a new Deepgram Voice Agent session for a call.
   *
   * In a typical telephony flow, the actual phone call is initiated by the
   * telephony provider (Twilio/Telnyx). This method creates the Deepgram
   * agent that handles the voice AI pipeline for that call.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const providerCallId = `dg-${input.callId}`;

    const client = this.createClient(input.callId);

    const session: ActiveSession = {
      client,
      callId: input.callId,
      providerCallId,
    };
    this.sessions.set(input.callId, session);

    this.wireEvents(session);

    try {
      await client.connect();
    } catch (error) {
      this.sessions.delete(input.callId);
      throw error;
    }

    return { providerCallId, status: "initiated" };
  }

  /**
   * Hang up by closing the Deepgram Voice Agent WebSocket.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    const session = this.sessions.get(input.callId);
    if (session) {
      session.client.close();
      this.sessions.delete(input.callId);
    }
  }

  /**
   * Inject text as an agent message.
   * Deepgram handles TTS internally; this sends text to be spoken.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const session = this.sessions.get(input.callId);
    if (!session) {
      throw new Error(`No active Deepgram session for call ${input.callId}`);
    }
    session.client.injectAgentMessage(input.text);
  }

  /**
   * No-op: Deepgram Voice Agent handles listening automatically via its
   * built-in STT pipeline. The agent is always listening for user speech.
   */
  async startListening(_input: StartListeningInput): Promise<void> {
    // Deepgram handles STT automatically
  }

  /**
   * No-op: Deepgram Voice Agent handles listening automatically.
   */
  async stopListening(_input: StopListeningInput): Promise<void> {
    // Deepgram handles STT automatically
  }

  // -----------------------------------------------------------------------
  // Public API (beyond VoiceCallProvider)
  // -----------------------------------------------------------------------

  /**
   * Get the active DeepgramVoiceAgentClient for a call.
   */
  getClient(callId: string): DeepgramVoiceAgentClient | undefined {
    return this.sessions.get(callId)?.client;
  }

  /**
   * Create a Deepgram Voice Agent session for an existing call
   * (e.g. inbound call already connected via Twilio).
   */
  async createSession(
    callId: string,
    providerCallId: string,
    overrides?: DeepgramSessionOverrides,
  ): Promise<DeepgramVoiceAgentClient> {
    const client = this.createClient(callId, overrides);

    const session: ActiveSession = {
      client,
      callId,
      providerCallId,
    };
    this.sessions.set(callId, session);
    this.wireEvents(session);

    await client.connect();
    return client;
  }

  /**
   * Send raw audio to the Deepgram agent for a call.
   * Audio is forwarded from telephony media streams.
   */
  sendAudio(callId: string, audio: Buffer): void {
    this.sessions.get(callId)?.client.sendAudio(audio);
  }

  /**
   * Update the system prompt mid-call (e.g. agent handoff).
   */
  updatePrompt(callId: string, instructions: string): void {
    this.sessions.get(callId)?.client.updatePrompt(instructions);
  }

  /**
   * Update the TTS voice/model mid-call.
   */
  updateSpeak(callId: string, model: string): void {
    this.sessions.get(callId)?.client.updateSpeak(model);
  }

  /**
   * Close a specific session.
   */
  closeSession(callId: string): void {
    const session = this.sessions.get(callId);
    if (session) {
      session.client.close();
      this.fallback.cleanup(callId);
      this.sessions.delete(callId);
    }
  }

  /**
   * Close all active sessions.
   */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.client.close();
      this.fallback.cleanup(session.callId);
    }
    this.sessions.clear();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private createClient(
    callId: string,
    overrides?: DeepgramSessionOverrides,
  ): DeepgramVoiceAgentClient {
    // Wrap function call handler with fallback degradation chain.
    // The fallback wrapper adds timeout + 4-tier escalation. Then the
    // client's built-in filler injection (from latency config) wraps
    // around it so callers hear something while waiting.
    let onFunctionCall = this.options.onFunctionCall;

    // We need a reference to the client for fallback to inject messages,
    // but the client needs the wrapped handler at construction time.
    // Use a deferred approach: create a mutable wrapper, create the client,
    // then wire up the fallback which needs the client reference.
    const wrappedRef: {
      fn?: (name: string, args: Record<string, unknown>, id: string) => Promise<string>;
    } = {};

    const client = new DeepgramVoiceAgentClient({
      apiKey: this.apiKey,
      sttModel: this.dgConfig.stt.model,
      ttsModel: this.dgConfig.tts.model,
      language: this.dgConfig.language,
      latency: this.dgConfig.latency,
      llmProvider: overrides?.llmProvider ?? this.options.llmProvider,
      llmModel: this.options.llmModel,
      llmEndpoint: overrides?.llmEndpoint ?? this.options.llmEndpoint,
      systemPrompt: overrides?.systemPrompt ?? this.options.systemPrompt,
      greeting: overrides?.greeting ?? this.options.greeting,
      functions: this.options.functions,
      keyterms: this.options.keyterms,
      inputEncoding: "mulaw",
      inputSampleRate: 8000,
      outputEncoding: "mulaw",
      outputSampleRate: 8000,
      onFunctionCall: onFunctionCall
        ? (name, args, fnCallId) => wrappedRef.fn!(name, args, fnCallId)
        : undefined,
    });

    if (onFunctionCall) {
      wrappedRef.fn = this.fallback.wrapFunctionCall(callId, client, onFunctionCall);
    }

    return client;
  }

  private wireEvents(session: ActiveSession): void {
    const { client, callId, providerCallId } = session;

    const makeBase = () => ({
      id: crypto.randomUUID(),
      callId,
      providerCallId,
      timestamp: Date.now(),
    });

    // Forward synthesized audio
    client.on("audio", (audio) => {
      this.options.onAudio?.(callId, audio);
    });

    // Conversation text → NormalizedEvent
    client.on("conversationText", (role, content) => {
      if (role === "user") {
        const event: NormalizedEvent = {
          ...makeBase(),
          type: "call.speech",
          transcript: content,
          isFinal: true,
          confidence: 1.0,
        };
        this.options.onEvent?.(callId, event);
      } else {
        const event: NormalizedEvent = {
          ...makeBase(),
          type: "call.speaking",
          text: content,
        };
        this.options.onEvent?.(callId, event);
      }
    });

    // Error → NormalizedEvent
    client.on("error", (error) => {
      const event: NormalizedEvent = {
        ...makeBase(),
        type: "call.error",
        error: error.message,
        retryable: true,
      };
      this.options.onEvent?.(callId, event);
    });

    // Connection closed → clean up
    client.on("closed", () => {
      this.fallback.cleanup(callId);
      this.sessions.delete(callId);
    });
  }
}
