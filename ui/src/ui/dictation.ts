/**
 * Browser-side dictation client.
 *
 * Orchestrates:
 * - Mic permission request via getUserMedia
 * - AudioContext and AudioWorklet setup for PCM capture
 * - WebSocket connection to the gateway (which proxies to Deepgram)
 * - Processing Deepgram transcript responses
 * - State management throughout the dictation lifecycle
 */

/**
 * Inline JavaScript source for the AudioWorklet processor.
 *
 * This is embedded rather than imported because:
 * 1. AudioWorklet processors must be loaded as separate modules via addModule()
 * 2. Bundlers don't always handle worklet files correctly
 * 3. The TypeScript source needs to be compiled to JavaScript for browser use
 *
 * This must be kept in sync with audio-worklet-processor.ts
 */
const WORKLET_SOURCE = `
const BUFFER_SIZE = 1280; // 80ms at 16kHz

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BUFFER_SIZE);
    this.bufferIndex = 0;
  }

  process(inputs, _outputs, _parameters) {
    const input = inputs[0]?.[0];
    if (!input) {
      return true;
    }

    for (let i = 0; i < input.length; i++) {
      this.buffer[this.bufferIndex++] = input[i];

      if (this.bufferIndex >= BUFFER_SIZE) {
        // Convert float32 to int16 PCM
        const pcm = new Int16Array(BUFFER_SIZE);
        for (let j = 0; j < BUFFER_SIZE; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Transfer the buffer to the main thread
        this.port.postMessage(pcm.buffer, [pcm.buffer]);

        // Allocate a new buffer for the next chunk
        this.buffer = new Float32Array(BUFFER_SIZE);
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

/**
 * Possible states of the dictation client.
 */
export type DictationState =
  | "idle"
  | "requesting-permission"
  | "connecting"
  | "recording"
  | "error";

/**
 * A transcript event from the speech recognition service.
 */
export type DictationTranscript = {
  /** The transcribed text */
  text: string;
  /** Whether this is a final (committed) transcript vs interim */
  isFinal: boolean;
  /** Whether Flux detected end-of-thought (speech_final) */
  speechFinal?: boolean;
};

/**
 * Callbacks for dictation events.
 */
export type DictationCallbacks = {
  /** Called when the dictation state changes */
  onStateChange: (state: DictationState) => void;
  /** Called when a transcript (interim or final) is received */
  onTranscript: (transcript: DictationTranscript) => void;
  /** Called when an error occurs. Special value "permission_denied" for mic permission errors */
  onError: (error: string) => void;
};

/**
 * Options for configuring the DictationClient.
 */
export type DictationClientOptions = {
  /** The gateway URL (http/https). Will be converted to ws/wss for WebSocket. */
  gatewayUrl: string;
  /** Callbacks for dictation events */
  callbacks: DictationCallbacks;
  /** Deepgram model to use (default: flux-general-en) */
  model?: string;
  /** Language code (default: en) */
  language?: string;
};

/**
 * Deepgram transcript result structure.
 * See: https://developers.deepgram.com/docs/results
 */
type DeepgramResult = {
  type: "Results";
  /** Whether this transcript segment is final (won't be revised) */
  is_final?: boolean;
  /** Whether Flux detected end-of-thought (Flux model feature) */
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
};

type DeepgramError = {
  type: "Error";
  message?: string;
};

type DeepgramTurnInfo = {
  type: "TurnInfo";
  transcript?: string;
  event?: string;
};

type DeepgramMessage = DeepgramResult | DeepgramError | DeepgramTurnInfo;

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    sampleRate: 16000,
    echoCancellation: true,
    noiseSuppression: true,
  },
};

const WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
const SAMPLE_RATE = 16000;

/**
 * Create a Blob URL for the AudioWorklet processor.
 *
 * AudioWorklet processors must be loaded as separate modules, but bundlers
 * don't always handle this well. By inlining the source and creating a Blob URL,
 * we ensure the worklet loads correctly in all environments.
 */
let workletBlobUrl: string | null = null;

function getWorkletUrl(): string {
  if (!workletBlobUrl) {
    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    workletBlobUrl = URL.createObjectURL(blob);
  }
  return workletBlobUrl;
}

/**
 * Client for browser-based voice dictation.
 *
 * Captures audio from the microphone, streams it to the gateway WebSocket
 * (which proxies to Deepgram), and receives real-time transcripts.
 *
 * Usage:
 * ```typescript
 * const client = new DictationClient({
 *   gatewayUrl: "http://localhost:18789",
 *   callbacks: {
 *     onStateChange: (state) => console.log("State:", state),
 *     onTranscript: ({ text, isFinal }) => console.log("Transcript:", text, isFinal),
 *     onError: (error) => console.error("Error:", error),
 *   },
 * });
 *
 * await client.start();
 * // ... user speaks ...
 * client.stop();
 * ```
 */
export class DictationClient {
  private state: DictationState = "idle";
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private ws: WebSocket | null = null;
  private callbacks: DictationCallbacks;
  private gatewayUrl: string;
  private model: string;
  private language: string;

  constructor(options: DictationClientOptions) {
    this.gatewayUrl = options.gatewayUrl;
    this.callbacks = options.callbacks;
    this.model = options.model ?? "flux-general-en";
    this.language = options.language ?? "en";
  }

  /**
   * Get the current state of the dictation client.
   */
  get currentState(): DictationState {
    return this.state;
  }

  /**
   * Start dictation.
   *
   * This will:
   * 1. Request microphone permission
   * 2. Connect to the gateway WebSocket
   * 3. Start capturing and streaming audio
   */
  async start(): Promise<void> {
    // Only start from idle or error states
    if (this.state !== "idle" && this.state !== "error") {
      return;
    }

    this.setState("requesting-permission");

    // Step 1: Request microphone permission
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      const error = err as Error;
      console.error("[dictation] mic permission error:", error.name, error.message);
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        this.callbacks.onError("permission_denied");
      } else {
        this.callbacks.onError(`Microphone error: ${error.message}`);
      }
      this.setState("error");
      return;
    }

    this.setState("connecting");

    // Step 2: Connect WebSocket and setup audio capture
    try {
      await this.connectWebSocket();
      await this.startAudioCapture();
      this.setState("recording");
    } catch (err) {
      this.callbacks.onError(`Connection error: ${(err as Error).message}`);
      this.cleanup();
      this.setState("error");
    }
  }

  /**
   * Stop dictation.
   *
   * Sends a finalize message to get any remaining transcript,
   * then cleans up all resources.
   */
  stop(): void {
    if (this.state !== "recording") {
      return;
    }

    // Send finalize to flush any remaining audio/transcript
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Finalize" }));
    }

    this.cleanup();
    this.setState("idle");
  }

  /**
   * Check if dictation is currently active.
   */
  get isRecording(): boolean {
    return this.state === "recording";
  }

  private setState(state: DictationState): void {
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  private buildWebSocketUrl(): string {
    // Convert http(s):// to ws(s)://
    const wsUrl = this.gatewayUrl.replace(/^http/, "ws");
    const url = new URL("/dictation/stream", wsUrl);
    url.searchParams.set("model", this.model);
    // Note: v2/listen doesn't support language parameter - Flux is English-only
    url.searchParams.set("sample_rate", String(SAMPLE_RATE));
    return url.toString();
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.buildWebSocketUrl();
      this.ws = new WebSocket(wsUrl);

      const timeout = window.setTimeout(() => {
        reject(new Error("Connection timeout"));
        this.ws?.close();
      }, WEBSOCKET_CONNECT_TIMEOUT_MS);

      this.ws.addEventListener("open", () => {
        window.clearTimeout(timeout);
        resolve();
      });

      this.ws.addEventListener("error", (e) => {
        console.error("[dictation] WebSocket error", e);
        window.clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      });

      this.ws.addEventListener("message", (event) => {
        this.handleMessage(event.data as string);
      });

      this.ws.addEventListener("close", () => {
        // If we're still recording, this is an unexpected close
        if (this.state === "recording") {
          this.callbacks.onError("Connection closed unexpectedly");
          this.cleanup();
          this.setState("error");
        }
      });
    });
  }

  private async startAudioCapture(): Promise<void> {
    // Create AudioContext at 16kHz to match Deepgram's expected sample rate
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

    // Resume AudioContext if it was suspended (browser autoplay policy)
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // Load the AudioWorklet processor from an inline Blob URL
    await this.audioContext.audioWorklet.addModule(getWorkletUrl());

    // Create source from the mic stream
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream!);

    // Create the worklet node
    this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-capture-processor");

    // Handle PCM data from the worklet
    this.workletNode.port.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(event.data);
      }
    });

    // MessagePort requires explicit start() when using addEventListener
    this.workletNode.port.start();

    // Connect the audio graph: mic -> worklet
    // We don't connect to destination since we don't want to play back the audio
    this.sourceNode.connect(this.workletNode);
  }

  private handleMessage(data: string): void {
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(data) as DeepgramMessage;
    } catch {
      // Ignore non-JSON messages
      return;
    }

    if (msg.type === "Error") {
      console.error("[dictation] error from server:", msg.message);
      this.callbacks.onError(msg.message ?? "Transcription error");
      return;
    }

    // v2 API sends TurnInfo messages instead of Results
    if (msg.type === "TurnInfo") {
      const transcript = msg.transcript ?? "";
      const isEndOfTurn = msg.event === "EndOfTurn";

      this.callbacks.onTranscript({
        text: transcript,
        isFinal: isEndOfTurn,
        speechFinal: isEndOfTurn,
      });

      // Auto-stop on EndOfTurn (Flux end-of-thought detection)
      if (isEndOfTurn && transcript) {
        this.stop();
      }
    }

    // v1 API sends Results messages (kept for backwards compatibility)
    if (msg.type === "Results") {
      const transcript = msg.channel?.alternatives?.[0]?.transcript ?? "";

      this.callbacks.onTranscript({
        text: transcript,
        isFinal: Boolean(msg.is_final),
        speechFinal: msg.speech_final,
      });

      // Auto-stop on speech_final (Flux end-of-thought detection)
      if (msg.speech_final) {
        this.stop();
      }
    }
  }

  private cleanup(): void {
    // Disconnect audio nodes
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    // Close AudioContext
    if (this.audioContext) {
      // Close can fail if already closed, ignore errors
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    // Stop all mic tracks
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    // Close WebSocket
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        // Send close stream message before closing
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * Check if dictation is supported in the current browser.
 *
 * Requires:
 * - navigator.mediaDevices.getUserMedia (for microphone access)
 * - AudioWorkletNode (for efficient audio processing)
 *
 * @returns true if all required APIs are available
 */
export function isDictationSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof AudioWorkletNode !== "undefined"
  );
}
