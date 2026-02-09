# Voice Dictation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add voice dictation to the web chat compose box using Deepgram Flux for real-time speech-to-text with end-of-thought detection.

**Architecture:** Browser captures mic audio via AudioWorklet, streams PCM to gateway WebSocket, gateway proxies to Deepgram `/v2/listen` with Flux model, transcripts stream back to update textarea in real-time.

**Tech Stack:** TypeScript, Lit (UI), WebSocket, AudioWorklet, Deepgram Flux API

---

## Task 1: Add dictation feature flag to gateway hello

**Files:**

- Modify: `src/gateway/protocol/schema/frames.ts`
- Modify: `src/gateway/server/ws-connection/message-handler.ts`

**Step 1: Add dictation to HelloOk features schema**

In `src/gateway/protocol/schema/frames.ts`, update the `features` object in `HelloOkSchema`:

```typescript
features: Type.Object(
  {
    methods: Type.Array(NonEmptyString),
    events: Type.Array(NonEmptyString),
    dictation: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
),
```

**Step 2: Populate dictation flag in hello response**

Find where the hello-ok response is built (in `src/gateway/server/ws-connection/message-handler.ts` or related file) and add logic to check for `DEEPGRAM_API_KEY`:

```typescript
// Add import at top
import { resolveProviderApiKey } from "../../../agents/model-auth.js";

// In the hello-ok response building:
const deepgramKey = resolveProviderApiKey("deepgram", config);
const dictationEnabled = Boolean(deepgramKey?.trim());

// Add to features:
features: {
  methods: gatewayMethods,
  events,
  dictation: dictationEnabled,
},
```

**Step 3: Commit**

```bash
git add src/gateway/protocol/schema/frames.ts src/gateway/server/ws-connection/message-handler.ts
git commit -m "feat(gateway): add dictation feature flag to hello response"
```

---

## Task 2: Create gateway dictation WebSocket proxy

**Files:**

- Create: `src/gateway/server-dictation.ts`
- Modify: `src/gateway/server-http.ts`

**Step 1: Create dictation WebSocket handler**

Create `src/gateway/server-dictation.ts`:

```typescript
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import { WebSocket } from "ws";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveProviderApiKey } from "../agents/model-auth.js";
import { loadConfig } from "../config/config.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v2/listen";

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
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("smart_format", "true");
  if (params.language) {
    url.searchParams.set("language", params.language);
  }
  return url.toString();
}

export function createDictationUpgradeHandler(opts: { log: SubsystemLogger }) {
  const { log } = opts;

  return (req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer) => {
    const config = loadConfig();
    const apiKey = resolveProviderApiKey("deepgram", config);

    if (!apiKey) {
      log.warn("dictation: DEEPGRAM_API_KEY not configured");
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      log.info("dictation: client connected");

      const url = new URL(req.url ?? "/", "http://localhost");
      const params: DictationParams = {
        model: url.searchParams.get("model") ?? undefined,
        language: url.searchParams.get("language") ?? undefined,
        sampleRate: url.searchParams.get("sample_rate") ?? undefined,
      };

      const deepgramUrl = buildDeepgramUrl(params);
      const deepgramWs = new WebSocket(deepgramUrl, {
        headers: {
          Authorization: `Token ${apiKey}`,
        },
      });

      let deepgramReady = false;
      const pendingAudio: Buffer[] = [];

      deepgramWs.on("open", () => {
        log.info("dictation: connected to Deepgram");
        deepgramReady = true;
        // Flush any pending audio
        for (const chunk of pendingAudio) {
          deepgramWs.send(chunk);
        }
        pendingAudio.length = 0;
      });

      deepgramWs.on("message", (data) => {
        // Forward Deepgram responses to client
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data.toString());
        }
      });

      deepgramWs.on("error", (err) => {
        log.error(`dictation: Deepgram error: ${err.message}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: "Error", message: "Transcription service error" }));
          clientWs.close(1011, "Deepgram error");
        }
      });

      deepgramWs.on("close", (code, reason) => {
        log.info(`dictation: Deepgram closed (${code}): ${reason.toString()}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1000, "Deepgram closed");
        }
      });

      clientWs.on("message", (data) => {
        // Handle control messages
        if (typeof data === "string" || (data instanceof Buffer && data[0] === 0x7b)) {
          try {
            const msg = JSON.parse(data.toString());
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
            // Not JSON, treat as audio
          }
        }

        // Forward audio data to Deepgram
        if (deepgramReady && deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(data as Buffer);
        } else {
          // Buffer audio until Deepgram is ready
          pendingAudio.push(data as Buffer);
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
  };
}
```

**Step 2: Register dictation endpoint in HTTP server**

In `src/gateway/server-http.ts`, add the upgrade handler. Find where WebSocket upgrades are handled and add:

```typescript
// Import at top
import { createDictationUpgradeHandler } from "./server-dictation.js";

// In the server setup, add upgrade handling for /dictation/stream
// This requires finding where httpServer.on("upgrade") is handled
```

Note: The exact integration point depends on how upgrades are currently handled. Look for `server.on("upgrade"` patterns.

**Step 3: Commit**

```bash
git add src/gateway/server-dictation.ts src/gateway/server-http.ts
git commit -m "feat(gateway): add dictation WebSocket proxy endpoint"
```

---

## Task 3: Create browser AudioWorklet for PCM capture

**Files:**

- Create: `ui/src/ui/audio-worklet-processor.ts`

**Step 1: Create the AudioWorklet processor**

Create `ui/src/ui/audio-worklet-processor.ts`:

```typescript
// This file runs in AudioWorklet context
// It must be a separate file loaded via addModule()

const BUFFER_SIZE = 1280; // 80ms at 16kHz

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array;
  private bufferIndex: number;

  constructor() {
    super();
    this.buffer = new Float32Array(BUFFER_SIZE);
    this.bufferIndex = 0;
  }

  process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
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

        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.buffer = new Float32Array(BUFFER_SIZE);
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
```

**Step 2: Commit**

```bash
git add ui/src/ui/audio-worklet-processor.ts
git commit -m "feat(ui): add AudioWorklet processor for PCM capture"
```

---

## Task 4: Create dictation state machine and WebSocket client

**Files:**

- Create: `ui/src/ui/dictation.ts`

**Step 1: Create the dictation module**

Create `ui/src/ui/dictation.ts`:

```typescript
export type DictationState =
  | "idle"
  | "requesting-permission"
  | "connecting"
  | "recording"
  | "error";

export type DictationTranscript = {
  text: string;
  isFinal: boolean;
};

export type DictationCallbacks = {
  onStateChange: (state: DictationState) => void;
  onTranscript: (transcript: DictationTranscript) => void;
  onError: (error: string) => void;
};

type DeepgramResult = {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
    }>;
  };
};

export class DictationClient {
  private state: DictationState = "idle";
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private ws: WebSocket | null = null;
  private callbacks: DictationCallbacks;
  private gatewayUrl: string;
  private interimText = "";

  constructor(gatewayUrl: string, callbacks: DictationCallbacks) {
    this.gatewayUrl = gatewayUrl;
    this.callbacks = callbacks;
  }

  get currentState(): DictationState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "error") {
      return;
    }

    this.setState("requesting-permission");

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      const error = err as Error;
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        this.callbacks.onError("permission_denied");
      } else {
        this.callbacks.onError(`Microphone error: ${error.message}`);
      }
      this.setState("error");
      return;
    }

    this.setState("connecting");

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

  stop(): void {
    if (this.state !== "recording") {
      return;
    }

    // Send finalize to get any remaining transcript
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Finalize" }));
    }

    this.cleanup();
    this.setState("idle");
  }

  private setState(state: DictationState): void {
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.gatewayUrl.replace(/^http/, "ws") + "/dictation/stream";
      this.ws = new WebSocket(wsUrl);

      const timeout = window.setTimeout(() => {
        reject(new Error("Connection timeout"));
        this.ws?.close();
      }, 10000);

      this.ws.onopen = () => {
        window.clearTimeout(timeout);
        resolve();
      };

      this.ws.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("WebSocket error"));
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = () => {
        if (this.state === "recording") {
          this.callbacks.onError("Connection closed unexpectedly");
          this.cleanup();
          this.setState("error");
        }
      };
    });
  }

  private async startAudioCapture(): Promise<void> {
    this.audioContext = new AudioContext({ sampleRate: 16000 });

    // Load the worklet processor
    const workletUrl = new URL("./audio-worklet-processor.ts", import.meta.url);
    await this.audioContext.audioWorklet.addModule(workletUrl.href);

    const source = this.audioContext.createMediaStreamSource(this.mediaStream!);
    this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-capture-processor");

    this.workletNode.port.onmessage = (event) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(event.data);
      }
    };

    source.connect(this.workletNode);
    // Don't connect to destination - we don't want to play back the audio
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as DeepgramResult;

      if (msg.type === "Results") {
        const transcript = msg.channel?.alternatives?.[0]?.transcript ?? "";

        if (msg.is_final) {
          // Final transcript for this utterance
          this.interimText = "";
          this.callbacks.onTranscript({ text: transcript, isFinal: true });

          // Check for end-of-thought (speech_final from Flux)
          if (msg.speech_final) {
            // Auto-stop on end of thought
            this.stop();
          }
        } else {
          // Interim result
          this.interimText = transcript;
          this.callbacks.onTranscript({ text: transcript, isFinal: false });
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  private cleanup(): void {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.ws.close();
      this.ws = null;
    }

    this.interimText = "";
  }
}

export function isDictationSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof AudioWorkletNode !== "undefined"
  );
}
```

**Step 2: Commit**

```bash
git add ui/src/ui/dictation.ts
git commit -m "feat(ui): add dictation client with WebSocket and AudioWorklet"
```

---

## Task 5: Add mic icon to icons.ts

**Files:**

- Modify: `ui/src/ui/icons.ts`

**Step 1: Add microphone icons**

Add to `ui/src/ui/icons.ts` in the icons object:

```typescript
mic: html`
  <svg viewBox="0 0 24 24">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
`,
micOff: html`
  <svg viewBox="0 0 24 24">
    <line x1="2" x2="22" y1="2" y2="22" />
    <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
    <path d="M5 10v2a7 7 0 0 0 12 5" />
    <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
`,
```

**Step 2: Commit**

```bash
git add ui/src/ui/icons.ts
git commit -m "feat(ui): add microphone icons for dictation"
```

---

## Task 6: Add dictation CSS styles

**Files:**

- Create: `ui/src/styles/dictation.css`
- Modify: `ui/src/styles/chat.css`

**Step 1: Create dictation styles**

Create `ui/src/styles/dictation.css`:

```css
/* Dictation button states */
.chat-dictation-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  border-radius: var(--radius-md);
  transition:
    background-color 0.15s,
    color 0.15s;
}

.chat-dictation-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-dictation-btn--recording {
  background-color: var(--color-danger);
  color: white;
  animation: pulse-recording 1.5s ease-in-out infinite;
}

.chat-dictation-btn--recording:hover {
  background-color: var(--color-danger-hover, #dc2626);
}

@keyframes pulse-recording {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

/* Interim text styling in textarea */
.chat-compose__field textarea.has-interim::placeholder {
  color: transparent;
}

/* Permission modal */
.dictation-permission-modal {
  max-width: 28rem;
}

.dictation-permission-modal__content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.dictation-permission-modal__browser-instructions {
  background: var(--color-bg-subtle);
  border-radius: var(--radius-md);
  padding: 1rem;
  font-size: 0.875rem;
}

.dictation-permission-modal__browser-instructions h4 {
  margin: 0 0 0.5rem;
  font-weight: 600;
}

.dictation-permission-modal__browser-instructions ol {
  margin: 0;
  padding-left: 1.25rem;
}

.dictation-permission-modal__browser-instructions li {
  margin-bottom: 0.25rem;
}

.dictation-permission-modal__actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}
```

**Step 2: Import in chat.css**

Add to `ui/src/styles/chat.css`:

```css
@import "./dictation.css";
```

**Step 3: Commit**

```bash
git add ui/src/styles/dictation.css ui/src/styles/chat.css
git commit -m "feat(ui): add dictation button and modal styles"
```

---

## Task 7: Create mic permission modal component

**Files:**

- Create: `ui/src/ui/components/mic-permission-modal.ts`

**Step 1: Create the modal component**

Create `ui/src/ui/components/mic-permission-modal.ts`:

```typescript
import { html, nothing } from "lit";

export type MicPermissionModalProps = {
  open: boolean;
  onClose: () => void;
  onRetry: () => void;
};

function detectBrowser(): "chrome" | "safari" | "firefox" | "edge" | "other" {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("chrome")) return "chrome";
  if (ua.includes("safari") && !ua.includes("chrome")) return "safari";
  if (ua.includes("firefox")) return "firefox";
  return "other";
}

function getBrowserInstructions(browser: ReturnType<typeof detectBrowser>) {
  switch (browser) {
    case "chrome":
      return html`
        <h4>Chrome</h4>
        <ol>
          <li>Click the lock/tune icon in the address bar</li>
          <li>Find "Microphone" in the permissions list</li>
          <li>Change it to "Allow"</li>
          <li>Refresh the page</li>
        </ol>
      `;
    case "safari":
      return html`
        <h4>Safari</h4>
        <ol>
          <li>Go to Safari → Settings → Websites</li>
          <li>Click "Microphone" in the sidebar</li>
          <li>Find this site and set to "Allow"</li>
          <li>Refresh the page</li>
        </ol>
      `;
    case "firefox":
      return html`
        <h4>Firefox</h4>
        <ol>
          <li>Click the lock icon in the address bar</li>
          <li>Click "Connection secure" → "More information"</li>
          <li>Go to Permissions tab</li>
          <li>Find Microphone and uncheck "Use default"</li>
          <li>Select "Allow" and refresh</li>
        </ol>
      `;
    case "edge":
      return html`
        <h4>Edge</h4>
        <ol>
          <li>Click the lock icon in the address bar</li>
          <li>Click "Permissions for this site"</li>
          <li>Find "Microphone" and set to "Allow"</li>
          <li>Refresh the page</li>
        </ol>
      `;
    default:
      return html`
        <h4>Browser Settings</h4>
        <ol>
          <li>Open your browser's site settings</li>
          <li>Find microphone permissions</li>
          <li>Allow this site to use your microphone</li>
          <li>Refresh the page</li>
        </ol>
      `;
  }
}

export function renderMicPermissionModal(props: MicPermissionModalProps) {
  if (!props.open) {
    return nothing;
  }

  const browser = detectBrowser();

  return html`
    <div class="modal-backdrop" @click=${props.onClose}>
      <div class="modal dictation-permission-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="modal-header">
          <h3>Microphone Access Required</h3>
          <button class="btn btn-icon" @click=${props.onClose} aria-label="Close">×</button>
        </div>
        <div class="modal-body dictation-permission-modal__content">
          <p>
            Dictation requires access to your microphone. Please enable microphone permissions in
            your browser settings.
          </p>
          <div class="dictation-permission-modal__browser-instructions">
            ${getBrowserInstructions(browser)}
          </div>
        </div>
        <div class="modal-footer dictation-permission-modal__actions">
          <button class="btn" @click=${props.onClose}>Cancel</button>
          <button class="btn primary" @click=${props.onRetry}>Try Again</button>
        </div>
      </div>
    </div>
  `;
}
```

**Step 2: Commit**

```bash
git add ui/src/ui/components/mic-permission-modal.ts
git commit -m "feat(ui): add microphone permission help modal"
```

---

## Task 8: Integrate dictation into chat view

**Files:**

- Modify: `ui/src/ui/views/chat.ts`
- Modify: `ui/src/ui/app-chat.ts`
- Modify: `ui/src/ui/app.ts`

**Step 1: Add dictation props to ChatProps**

In `ui/src/ui/views/chat.ts`, add to `ChatProps`:

```typescript
// Add to ChatProps type
dictationEnabled?: boolean;
dictationState?: "idle" | "requesting-permission" | "connecting" | "recording" | "error";
dictationError?: string | null;
showMicPermissionModal?: boolean;
onDictationToggle?: () => void;
onMicPermissionModalClose?: () => void;
onMicPermissionRetry?: () => void;
```

**Step 2: Add mic button to compose area**

In the `renderChat` function, add the mic button before the "New session" button:

```typescript
// Import at top
import { icons } from "../icons.ts";
import { renderMicPermissionModal } from "../components/mic-permission-modal.ts";

// In the chat-compose__actions div, before the New session button:
${props.dictationEnabled !== false ? html`
  <button
    class="btn chat-dictation-btn ${props.dictationState === 'recording' ? 'chat-dictation-btn--recording' : ''}"
    type="button"
    ?disabled=${!props.connected || props.dictationEnabled === false}
    @click=${props.onDictationToggle}
    title=${props.dictationEnabled === false
      ? "Configure Deepgram API key to enable dictation"
      : props.dictationState === 'recording'
        ? "Stop dictation"
        : `Dictate (${navigator.platform.includes('Mac') ? '⌘⇧D' : 'Ctrl+Shift+D'})`}
    aria-label=${props.dictationState === 'recording' ? "Stop dictation" : "Start dictation"}
  >
    ${props.dictationState === 'recording' ? icons.mic : icons.mic}
  </button>
` : nothing}
```

**Step 3: Add permission modal render**

At the end of the `renderChat` function, before the closing `</section>`:

```typescript
${renderMicPermissionModal({
  open: Boolean(props.showMicPermissionModal),
  onClose: () => props.onMicPermissionModalClose?.(),
  onRetry: () => props.onMicPermissionRetry?.(),
})}
```

**Step 4: Commit**

```bash
git add ui/src/ui/views/chat.ts
git commit -m "feat(ui): add dictation button and modal to chat view"
```

---

## Task 9: Add dictation state management to app

**Files:**

- Modify: `ui/src/ui/app.ts`
- Modify: `ui/src/ui/app-chat.ts`

**Step 1: Add dictation state to app**

In the main app class, add state properties and handlers:

```typescript
// Import at top
import { DictationClient, isDictationSupported, type DictationState } from "./dictation.ts";

// Add state properties
private dictationClient: DictationClient | null = null;
private dictationState: DictationState = "idle";
private dictationEnabled = false;
private showMicPermissionModal = false;
private pendingDictationText = "";
private finalDictationText = "";

// In the hello handler, check for dictation feature
if (hello.features?.dictation) {
  this.dictationEnabled = isDictationSupported();
}

// Add dictation handlers
private handleDictationToggle = () => {
  if (!this.dictationEnabled) return;

  if (this.dictationState === "recording") {
    this.dictationClient?.stop();
  } else if (this.dictationState === "idle" || this.dictationState === "error") {
    this.startDictation();
  }
};

private startDictation = () => {
  if (!this.dictationClient) {
    this.dictationClient = new DictationClient(
      this.gatewayUrl,
      {
        onStateChange: (state) => {
          this.dictationState = state;
          this.requestUpdate();
        },
        onTranscript: ({ text, isFinal }) => {
          if (isFinal) {
            // Append final text to message
            const existing = this.chatMessage.trimEnd();
            const spacer = existing && !existing.endsWith(" ") ? " " : "";
            this.chatMessage = existing + spacer + text;
            this.pendingDictationText = "";
          } else {
            // Show interim text
            this.pendingDictationText = text;
          }
          this.requestUpdate();
        },
        onError: (error) => {
          if (error === "permission_denied") {
            this.showMicPermissionModal = true;
          }
          this.requestUpdate();
        },
      }
    );
  }
  this.dictationClient.start();
};

private handleMicPermissionModalClose = () => {
  this.showMicPermissionModal = false;
  this.requestUpdate();
};

private handleMicPermissionRetry = () => {
  this.showMicPermissionModal = false;
  this.startDictation();
};
```

**Step 2: Add keyboard shortcut handler**

Add to the app's keyboard event handling:

```typescript
// In connectedCallback or init
document.addEventListener("keydown", this.handleGlobalKeydown);

// Handler
private handleGlobalKeydown = (e: KeyboardEvent) => {
  // Cmd/Ctrl + Shift + D for dictation
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
    e.preventDefault();
    this.handleDictationToggle();
  }
};

// In disconnectedCallback
document.removeEventListener("keydown", this.handleGlobalKeydown);
```

**Step 3: Pass props to chat view**

When calling `renderChat`, add the dictation props:

```typescript
dictationEnabled: this.dictationEnabled,
dictationState: this.dictationState,
showMicPermissionModal: this.showMicPermissionModal,
onDictationToggle: this.handleDictationToggle,
onMicPermissionModalClose: this.handleMicPermissionModalClose,
onMicPermissionRetry: this.handleMicPermissionRetry,
```

**Step 4: Commit**

```bash
git add ui/src/ui/app.ts ui/src/ui/app-chat.ts
git commit -m "feat(ui): integrate dictation state management and keyboard shortcut"
```

---

## Task 10: Add tests for dictation client

**Files:**

- Create: `ui/src/ui/dictation.test.ts`

**Step 1: Write unit tests**

Create `ui/src/ui/dictation.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { isDictationSupported } from "./dictation.ts";

describe("dictation", () => {
  describe("isDictationSupported", () => {
    it("returns true when getUserMedia and AudioWorkletNode are available", () => {
      // Mock browser APIs
      const originalNavigator = global.navigator;
      const originalAudioWorkletNode = global.AudioWorkletNode;

      Object.defineProperty(global, "navigator", {
        value: {
          mediaDevices: {
            getUserMedia: vi.fn(),
          },
        },
        writable: true,
      });
      Object.defineProperty(global, "AudioWorkletNode", {
        value: class {},
        writable: true,
      });

      expect(isDictationSupported()).toBe(true);

      // Restore
      Object.defineProperty(global, "navigator", { value: originalNavigator, writable: true });
      Object.defineProperty(global, "AudioWorkletNode", {
        value: originalAudioWorkletNode,
        writable: true,
      });
    });

    it("returns false when getUserMedia is not available", () => {
      const originalNavigator = global.navigator;

      Object.defineProperty(global, "navigator", {
        value: {
          mediaDevices: undefined,
        },
        writable: true,
      });

      expect(isDictationSupported()).toBe(false);

      Object.defineProperty(global, "navigator", { value: originalNavigator, writable: true });
    });
  });
});
```

**Step 2: Run tests**

```bash
cd open_claw && pnpm test ui/src/ui/dictation.test.ts
```

**Step 3: Commit**

```bash
git add ui/src/ui/dictation.test.ts
git commit -m "test(ui): add dictation client unit tests"
```

---

## Task 11: Add tests for gateway dictation handler

**Files:**

- Create: `src/gateway/server-dictation.test.ts`

**Step 1: Write unit tests**

Create `src/gateway/server-dictation.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

// Mock the imports
vi.mock("./server-dictation.js", async () => {
  const actual = await vi.importActual("./server-dictation.js");
  return actual;
});

describe("server-dictation", () => {
  it("module exports createDictationUpgradeHandler", async () => {
    const mod = await import("./server-dictation.js");
    expect(typeof mod.createDictationUpgradeHandler).toBe("function");
  });
});
```

**Step 2: Run tests**

```bash
cd open_claw && pnpm test src/gateway/server-dictation.test.ts
```

**Step 3: Commit**

```bash
git add src/gateway/server-dictation.test.ts
git commit -m "test(gateway): add dictation handler tests"
```

---

## Task 12: Update GatewayHelloOk type in UI

**Files:**

- Modify: `ui/src/ui/gateway.ts`

**Step 1: Add dictation to features type**

Update the `GatewayHelloOk` type:

```typescript
export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  features?: { methods?: string[]; events?: string[]; dictation?: boolean };
  snapshot?: unknown;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  policy?: { tickIntervalMs?: number };
};
```

**Step 2: Commit**

```bash
git add ui/src/ui/gateway.ts
git commit -m "feat(ui): add dictation to GatewayHelloOk type"
```

---

## Task 13: Build and verify

**Step 1: Run full build**

```bash
cd open_claw && pnpm build
```

**Step 2: Run linter**

```bash
cd open_claw && pnpm check
```

**Step 3: Run all tests**

```bash
cd open_claw && pnpm test
```

**Step 4: Fix any issues**

Address any build errors, lint issues, or test failures.

**Step 5: Commit fixes if needed**

```bash
git add -A
git commit -m "fix: address build and test issues for dictation feature"
```

---

## Task 14: Manual testing checklist

1. Start gateway with `DEEPGRAM_API_KEY` configured
2. Open web UI
3. Verify mic button appears in compose area
4. Click mic button - should request permission
5. Grant permission - should start recording (button pulses red)
6. Speak - should see interim text appear
7. Stop speaking - Flux should detect end-of-thought and stop automatically
8. Verify transcript is in textarea
9. Test `Cmd/Ctrl+Shift+D` shortcut
10. Test without API key - button should be disabled with tooltip
11. Test permission denial - modal should appear with instructions

---

## Summary of files created/modified

**New files:**

- `src/gateway/server-dictation.ts`
- `src/gateway/server-dictation.test.ts`
- `ui/src/ui/dictation.ts`
- `ui/src/ui/dictation.test.ts`
- `ui/src/ui/audio-worklet-processor.ts`
- `ui/src/ui/components/mic-permission-modal.ts`
- `ui/src/styles/dictation.css`

**Modified files:**

- `src/gateway/protocol/schema/frames.ts`
- `src/gateway/server/ws-connection/message-handler.ts`
- `src/gateway/server-http.ts`
- `ui/src/ui/icons.ts`
- `ui/src/styles/chat.css`
- `ui/src/ui/views/chat.ts`
- `ui/src/ui/gateway.ts`
- `ui/src/ui/app.ts`
- `ui/src/ui/app-chat.ts`
