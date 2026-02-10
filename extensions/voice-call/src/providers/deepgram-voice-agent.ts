/**
 * Deepgram Voice Agent WebSocket Client
 *
 * Manages a WebSocket connection to the Deepgram Voice Agent API for
 * fully managed voice conversations. Deepgram handles STT, LLM, and TTS
 * internally; this client bridges telephony audio and function calls.
 *
 * Protocol: wss://agent.deepgram.com/v1/agent/converse
 *
 * @see https://developers.deepgram.com/docs/voice-agent
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { DeepgramLatencyConfig } from "../config.js";
import { generateFillerPhrase } from "../filler.js";

// ---------------------------------------------------------------------------
// Types — Deepgram Voice Agent Protocol
// ---------------------------------------------------------------------------

/** Audio encoding formats supported by the Deepgram Voice Agent API. */
export type DeepgramAudioEncoding =
  | "linear16"
  | "mulaw"
  | "alaw"
  | "flac"
  | "opus"
  | "ogg-opus"
  | "speex"
  | "amr-nb"
  | "amr-wb";

/** Output-only encoding formats (subset of input). */
export type DeepgramOutputEncoding = "linear16" | "mulaw" | "alaw";

/** LLM provider identifiers accepted by the Deepgram think stage. */
export type DeepgramThinkProvider =
  | "deepgram"
  | "open_ai"
  | "anthropic"
  | "google"
  | "groq"
  | "aws_bedrock"
  | "custom";

/** TTS provider identifiers accepted by the Deepgram speak stage. */
export type DeepgramSpeakProvider =
  | "deepgram"
  | "eleven_labs"
  | "cartesia"
  | "open_ai"
  | "aws_polly";

// -- Function definition for Settings ----------------------------------------

export interface DeepgramFunctionParameter {
  type: string;
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface DeepgramFunctionEndpoint {
  url: string;
  method: string;
  headers?: Record<string, string>;
}

export interface DeepgramFunctionDef {
  name: string;
  description: string;
  parameters: DeepgramFunctionParameter;
  /** If provided, Deepgram executes the function server-side. Omit for client-side. */
  endpoint?: DeepgramFunctionEndpoint;
}

// -- Client → Server messages ------------------------------------------------

export interface DeepgramSettings {
  type: "Settings";
  audio: {
    input: {
      encoding: DeepgramAudioEncoding;
      sample_rate: number;
    };
    output: {
      encoding: DeepgramOutputEncoding;
      sample_rate: number;
      container?: string;
      bitrate?: number;
    };
  };
  agent: {
    language?: string;
    listen: {
      provider: {
        type: "deepgram";
        model?: string;
        keyterms?: string[];
        smart_format?: boolean;
      };
    };
    think: {
      provider: {
        type: DeepgramThinkProvider;
        model?: string;
        temperature?: number;
      };
      prompt?: string;
      context_length?: number | "max";
      functions?: DeepgramFunctionDef[];
      endpoint?: { url: string; headers?: Record<string, string> };
    };
    speak: {
      provider: {
        type: DeepgramSpeakProvider;
        model?: string;
        model_id?: string;
        voice?: string;
        language_code?: string;
      };
      endpoint?: { url: string; headers?: Record<string, string> };
    };
    context?: {
      messages?: Array<{
        role: "user" | "assistant";
        content: string;
      }>;
    };
    greeting?: string;
  };
  tags?: string[];
  experimental?: boolean;
  mip_opt_out?: boolean;
  flags?: { history?: boolean };
}

export interface DeepgramUpdateInstructions {
  type: "UpdateInstructions";
  instructions: string;
}

export interface DeepgramUpdateSpeak {
  type: "UpdateSpeak";
  model: string;
}

export interface DeepgramInjectAgentMessage {
  type: "InjectAgentMessage";
  message: string;
}

export interface DeepgramInjectUserMessage {
  type: "InjectUserMessage";
  message: string;
}

export interface DeepgramClientFunctionCallResponse {
  type: "FunctionCallResponse";
  id: string;
  name: string;
  content: string;
}

export interface DeepgramKeepAlive {
  type: "KeepAlive";
}

export type DeepgramClientMessage =
  | DeepgramSettings
  | DeepgramUpdateInstructions
  | DeepgramUpdateSpeak
  | DeepgramInjectAgentMessage
  | DeepgramInjectUserMessage
  | DeepgramClientFunctionCallResponse
  | DeepgramKeepAlive;

// -- Server → Client messages ------------------------------------------------

export interface DeepgramWelcome {
  type: "Welcome";
  request_id: string;
}

export interface DeepgramSettingsApplied {
  type: "SettingsApplied";
}

export interface DeepgramUserStartedSpeaking {
  type: "UserStartedSpeaking";
}

export interface DeepgramAgentStartedSpeaking {
  type: "AgentStartedSpeaking";
  total_latency?: number;
  tts_latency?: number;
  ttt_latency?: number;
}

export interface DeepgramAgentThinking {
  type: "AgentThinking";
}

export interface DeepgramConversationText {
  type: "ConversationText";
  role: "user" | "assistant";
  content: string;
}

export interface DeepgramFunctionCallRequest {
  type: "FunctionCallRequest";
  functions: Array<{
    id: string;
    name: string;
    arguments: string;
    client_side: boolean;
  }>;
}

export interface DeepgramAgentAudioDone {
  type: "AgentAudioDone";
}

export interface DeepgramPromptUpdated {
  type: "PromptUpdated";
}

export interface DeepgramSpeakUpdated {
  type: "SpeakUpdated";
}

export interface DeepgramInjectionRefused {
  type: "InjectionRefused";
  reason?: string;
}

export interface DeepgramServerError {
  type: "Error";
  description: string;
  code?: string;
}

export interface DeepgramServerWarning {
  type: "Warning";
  description: string;
  code?: string;
}

export type DeepgramServerMessage =
  | DeepgramWelcome
  | DeepgramSettingsApplied
  | DeepgramUserStartedSpeaking
  | DeepgramAgentStartedSpeaking
  | DeepgramAgentThinking
  | DeepgramConversationText
  | DeepgramFunctionCallRequest
  | DeepgramAgentAudioDone
  | DeepgramPromptUpdated
  | DeepgramSpeakUpdated
  | DeepgramInjectionRefused
  | DeepgramServerError
  | DeepgramServerWarning;

// ---------------------------------------------------------------------------
// Client Configuration
// ---------------------------------------------------------------------------

export interface DeepgramVoiceAgentConfig {
  /** Deepgram API key. */
  apiKey: string;

  /** STT model (default: "nova-3"). */
  sttModel?: string;
  /** TTS model (default: "aura-2-thalia-en"). */
  ttsModel?: string;
  /** TTS provider (default: "deepgram"). */
  ttsProvider?: DeepgramSpeakProvider;

  /** LLM provider type (default: "open_ai"). */
  llmProvider?: DeepgramThinkProvider;
  /** LLM model (default: "gpt-4o-mini"). */
  llmModel?: string;
  /** LLM temperature (0-2). */
  llmTemperature?: number;
  /** Custom LLM endpoint (for custom/self-hosted providers). */
  llmEndpoint?: { url: string; headers?: Record<string, string> };

  /** System prompt for the agent. */
  systemPrompt?: string;
  /** Greeting spoken when the agent connects. */
  greeting?: string;
  /** Language code (default: "en"). */
  language?: string;

  /** Client-side function definitions. */
  functions?: DeepgramFunctionDef[];

  /**
   * Callback invoked when Deepgram requests a client-side function call.
   * Must return the result as a string (JSON or plain text).
   */
  onFunctionCall?: (name: string, args: Record<string, unknown>, callId: string) => Promise<string>;

  /** Input audio encoding (default: "mulaw" — matches Twilio). */
  inputEncoding?: DeepgramAudioEncoding;
  /** Input audio sample rate (default: 8000 for telephony). */
  inputSampleRate?: number;
  /** Output audio encoding (default: "mulaw"). */
  outputEncoding?: DeepgramOutputEncoding;
  /** Output audio sample rate (default: 8000). */
  outputSampleRate?: number;

  /** Optional conversation context to restore. */
  context?: Array<{ role: "user" | "assistant"; content: string }>;

  /** Key terms to boost recognition accuracy. */
  keyterms?: string[];

  /** Latency-hiding filler configuration. */
  latency?: DeepgramLatencyConfig;

  /** Connection timeout in ms (default: 10000). */
  connectTimeoutMs?: number;
  /** Keep-alive interval in ms (default: 5000). */
  keepAliveIntervalMs?: number;
  /** Max reconnect attempts (default: 3). */
  maxReconnectAttempts?: number;
}

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

export interface DeepgramVoiceAgentEvents {
  /** Synthesized audio from Deepgram TTS (ready to forward to telephony). */
  audio: [audio: Buffer];
  /** Transcript of user or agent speech. */
  conversationText: [role: "user" | "assistant", content: string];
  /** User started speaking (barge-in signal). */
  userStartedSpeaking: [];
  /** Agent started speaking (with latency metrics). */
  agentStartedSpeaking: [latency?: { total?: number; tts?: number; ttt?: number }];
  /** Agent thinking (processing). */
  agentThinking: [];
  /** Agent finished sending audio for current utterance. */
  agentAudioDone: [];
  /** Function call requested by the agent. */
  functionCall: [name: string, args: Record<string, unknown>, callId: string];
  /** Filler phrase injected while waiting for a function call result. */
  fillerInjected: [phrase: string];
  /** Prompt was updated successfully. */
  promptUpdated: [];
  /** Speak model was updated successfully. */
  speakUpdated: [];
  /** Injection was refused (user speaking or agent responding). */
  injectionRefused: [reason?: string];
  /** Connection established. */
  connected: [requestId: string];
  /** Settings applied by server. */
  settingsApplied: [];
  /** Warning from server. */
  warning: [description: string, code?: string];
  /** Error from server or connection. */
  error: [error: Error];
  /** Connection closed. */
  closed: [code: number, reason: string];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[DeepgramVoiceAgent]";
const AGENT_WS_URL = "wss://agent.deepgram.com/v1/agent/converse";

export class DeepgramVoiceAgentClient extends EventEmitter<DeepgramVoiceAgentEvents> {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: Required<
    Pick<
      DeepgramVoiceAgentConfig,
      | "apiKey"
      | "sttModel"
      | "ttsModel"
      | "ttsProvider"
      | "llmProvider"
      | "llmModel"
      | "llmTemperature"
      | "systemPrompt"
      | "language"
      | "inputEncoding"
      | "inputSampleRate"
      | "outputEncoding"
      | "outputSampleRate"
      | "connectTimeoutMs"
      | "keepAliveIntervalMs"
      | "maxReconnectAttempts"
    >
  > &
    Omit<
      DeepgramVoiceAgentConfig,
      | "sttModel"
      | "ttsModel"
      | "ttsProvider"
      | "llmProvider"
      | "llmModel"
      | "llmTemperature"
      | "systemPrompt"
      | "language"
      | "inputEncoding"
      | "inputSampleRate"
      | "outputEncoding"
      | "outputSampleRate"
      | "connectTimeoutMs"
      | "keepAliveIntervalMs"
      | "maxReconnectAttempts"
    >;

  constructor(config: DeepgramVoiceAgentConfig) {
    super();
    this.config = {
      ...config,
      sttModel: config.sttModel ?? "nova-3",
      ttsModel: config.ttsModel ?? "aura-2-thalia-en",
      ttsProvider: config.ttsProvider ?? "deepgram",
      llmProvider: config.llmProvider ?? "open_ai",
      llmModel: config.llmModel ?? "gpt-4o-mini",
      llmTemperature: config.llmTemperature ?? 0.7,
      systemPrompt: config.systemPrompt ?? "",
      language: config.language ?? "en",
      inputEncoding: config.inputEncoding ?? "mulaw",
      inputSampleRate: config.inputSampleRate ?? 8000,
      outputEncoding: config.outputEncoding ?? "mulaw",
      outputSampleRate: config.outputSampleRate ?? 8000,
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
      keepAliveIntervalMs: config.keepAliveIntervalMs ?? 5_000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 3,
    };
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(AGENT_WS_URL, {
        headers: {
          Authorization: `Token ${this.config.apiKey}`,
        },
      });

      this.ws = ws;

      const timeout = setTimeout(() => {
        if (!this.connected) {
          ws.terminate();
          reject(new Error(`${LOG_PREFIX} Connection timeout`));
        }
      }, this.config.connectTimeoutMs);

      ws.on("open", () => {
        clearTimeout(timeout);
        console.log(`${LOG_PREFIX} WebSocket connected`);
        this.connected = true;
        this.reconnectAttempts = 0;

        // Send settings immediately on open
        this.sendSettings();

        // Start keep-alive
        this.startKeepAlive();
      });

      ws.on("message", (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          // Binary frames are audio data from TTS
          const audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data as string, "binary");
          this.emit("audio", audioBuffer);
          return;
        }

        // Text frames are JSON protocol messages
        try {
          const message = JSON.parse(data.toString()) as DeepgramServerMessage;
          this.handleServerMessage(message, resolve);
        } catch (e) {
          console.error(`${LOG_PREFIX} Failed to parse message:`, e);
        }
      });

      ws.on("error", (error) => {
        console.error(`${LOG_PREFIX} WebSocket error:`, error);
        this.emit("error", error);
        if (!this.connected) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      ws.on("close", (code, reason) => {
        const reasonStr = reason?.toString() || "none";
        console.log(`${LOG_PREFIX} WebSocket closed (code: ${code}, reason: ${reasonStr})`);
        this.connected = false;
        this.stopKeepAlive();
        this.emit("closed", code, reasonStr);

        if (!this.closed) {
          void this.attemptReconnect();
        }
      });
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error(
        `${LOG_PREFIX} Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = 1000 * 2 ** (this.reconnectAttempts - 1);
    console.log(
      `${LOG_PREFIX} Reconnecting ${this.reconnectAttempts}/${this.config.maxReconnectAttempts} in ${delay}ms...`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.closed) return;

    try {
      await this.doConnect();
      console.log(`${LOG_PREFIX} Reconnected successfully`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Reconnect failed:`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Server message handling
  // -------------------------------------------------------------------------

  private handleServerMessage(
    msg: DeepgramServerMessage,
    onSettingsApplied?: (value: void) => void,
  ): void {
    switch (msg.type) {
      case "Welcome":
        console.log(`${LOG_PREFIX} Welcome (request_id: ${msg.request_id})`);
        this.emit("connected", msg.request_id);
        break;

      case "SettingsApplied":
        console.log(`${LOG_PREFIX} Settings applied`);
        this.emit("settingsApplied");
        // Resolve the connect() promise once settings are confirmed
        onSettingsApplied?.();
        break;

      case "UserStartedSpeaking":
        this.emit("userStartedSpeaking");
        break;

      case "AgentStartedSpeaking":
        this.emit("agentStartedSpeaking", {
          total: msg.total_latency,
          tts: msg.tts_latency,
          ttt: msg.ttt_latency,
        });
        break;

      case "AgentThinking":
        this.emit("agentThinking");
        break;

      case "ConversationText":
        this.emit("conversationText", msg.role, msg.content);
        break;

      case "FunctionCallRequest":
        this.handleFunctionCallRequest(msg);
        break;

      case "AgentAudioDone":
        this.emit("agentAudioDone");
        break;

      case "PromptUpdated":
        this.emit("promptUpdated");
        break;

      case "SpeakUpdated":
        this.emit("speakUpdated");
        break;

      case "InjectionRefused":
        console.warn(`${LOG_PREFIX} Injection refused: ${msg.reason ?? "unknown"}`);
        this.emit("injectionRefused", msg.reason);
        break;

      case "Error":
        console.error(`${LOG_PREFIX} Server error: ${msg.description} (code: ${msg.code})`);
        this.emit("error", new Error(`Deepgram error: ${msg.description}`));
        break;

      case "Warning":
        console.warn(`${LOG_PREFIX} Server warning: ${msg.description} (code: ${msg.code})`);
        this.emit("warning", msg.description, msg.code);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Function calling
  // -------------------------------------------------------------------------

  private handleFunctionCallRequest(msg: DeepgramFunctionCallRequest): void {
    for (const fn of msg.functions) {
      if (!fn.client_side) continue;

      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch {
        parsedArgs = {};
      }

      this.emit("functionCall", fn.name, parsedArgs, fn.id);

      // If an onFunctionCall callback is configured, execute automatically
      if (this.config.onFunctionCall) {
        this.executeFunctionCallWithFiller(fn.id, fn.name, parsedArgs);
      }
    }
  }

  /**
   * Execute a function call with optional filler phrase injection.
   *
   * If the call takes longer than `fillerThresholdMs`, a randomly selected
   * filler phrase is injected via `InjectAgentMessage` so the caller hears
   * something while waiting.
   */
  private executeFunctionCallWithFiller(
    fnId: string,
    fnName: string,
    args: Record<string, unknown>,
  ): void {
    const latency = this.config.latency;
    const thresholdMs = latency?.fillerThresholdMs ?? 0;
    const phrases = latency?.fillerPhrases ?? [];
    const dynamicFiller = latency?.dynamicFiller ?? true;

    let fillerTimer: ReturnType<typeof setTimeout> | null = null;
    let completed = false;

    // Kick off dynamic filler generation in parallel (if enabled)
    let dynamicPhrase: string | null = null;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (dynamicFiller && apiKey && thresholdMs > 0) {
      void generateFillerPhrase({ toolName: fnName, args }, apiKey).then((phrase) => {
        dynamicPhrase = phrase;
      });
    }

    // Start a filler timer only when we have a threshold and phrases (or dynamic filler).
    if (thresholdMs > 0 && (phrases.length > 0 || dynamicFiller)) {
      fillerTimer = setTimeout(() => {
        if (completed) return;
        const phrase = dynamicPhrase ?? phrases[Math.floor(Math.random() * phrases.length)];
        if (!phrase) return;
        console.log(`${LOG_PREFIX} Injecting filler for "${fnName}": "${phrase}"`);
        this.injectAgentMessage(phrase);
        this.emit("fillerInjected", phrase);
      }, thresholdMs);
    }

    void this.config.onFunctionCall!(fnName, args, fnId)
      .then((result) => {
        completed = true;
        if (fillerTimer) clearTimeout(fillerTimer);
        this.sendFunctionCallResponse(fnId, fnName, result);
      })
      .catch((error) => {
        completed = true;
        if (fillerTimer) clearTimeout(fillerTimer);
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`${LOG_PREFIX} Function call "${fnName}" failed:`, errorMsg);
        this.sendFunctionCallResponse(fnId, fnName, JSON.stringify({ error: errorMsg }));
      });
  }

  // -------------------------------------------------------------------------
  // Client → Server messages
  // -------------------------------------------------------------------------

  private sendJson(message: DeepgramClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendSettings(): void {
    const settings: DeepgramSettings = {
      type: "Settings",
      audio: {
        input: {
          encoding: this.config.inputEncoding,
          sample_rate: this.config.inputSampleRate,
        },
        output: {
          encoding: this.config.outputEncoding,
          sample_rate: this.config.outputSampleRate,
          container: "none",
        },
      },
      agent: {
        language: this.config.language,
        listen: {
          provider: {
            type: "deepgram",
            model: this.config.sttModel,
            keyterms: this.config.keyterms,
          },
        },
        think: {
          provider: {
            type: this.config.llmProvider,
            model: this.config.llmModel,
            temperature: this.config.llmTemperature,
          },
          prompt: this.config.systemPrompt || undefined,
          functions: this.config.functions?.length ? this.config.functions : undefined,
          endpoint: this.config.llmEndpoint,
        },
        speak: {
          provider: {
            type: this.config.ttsProvider,
            model: this.config.ttsModel,
          },
        },
        greeting: this.config.greeting || undefined,
        context: this.config.context?.length ? { messages: this.config.context } : undefined,
      },
    };

    this.sendJson(settings);
  }

  /**
   * Forward raw telephony audio to Deepgram.
   * Send the audio buffer directly as a binary WebSocket frame.
   */
  sendAudio(audio: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(audio);
    }
  }

  /**
   * Update the system prompt mid-conversation (e.g. for agent handoffs).
   */
  updatePrompt(instructions: string): void {
    this.sendJson({ type: "UpdateInstructions", instructions });
  }

  /**
   * Update the TTS voice/model mid-conversation.
   */
  updateSpeak(model: string): void {
    this.sendJson({ type: "UpdateSpeak", model });
  }

  /**
   * Inject a message as if the agent said it.
   * Will be refused if user is speaking or agent is already responding.
   */
  injectAgentMessage(message: string): void {
    this.sendJson({ type: "InjectAgentMessage", message });
  }

  /**
   * Inject a message as if the user said it.
   */
  injectUserMessage(message: string): void {
    this.sendJson({ type: "InjectUserMessage", message });
  }

  /**
   * Send a function call response back to Deepgram.
   */
  sendFunctionCallResponse(id: string, name: string, content: string): void {
    this.sendJson({ type: "FunctionCallResponse", id, name, content });
  }

  // -------------------------------------------------------------------------
  // Keep-alive
  // -------------------------------------------------------------------------

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      this.sendJson({ type: "KeepAlive" });
    }, this.config.keepAliveIntervalMs);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /** Close the WebSocket connection. */
  close(): void {
    this.closed = true;
    this.stopKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /** Check if the client is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }
}
