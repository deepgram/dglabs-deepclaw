# Voice Call Extension

The most complex extension (~50 source files). Provides voice calling via telephony providers with AI-powered conversations using Deepgram Voice Agent or OpenAI Realtime STT.

## Architecture

```
Inbound:  Phone → Twilio → webhook server (:3334) → TwiML → media stream WS
                                                              ↓
          Deepgram Voice Agent ← audio bridge → Twilio media WS
                ↓                                     ↓
          STT → LLM (via gateway /v1/chat/completions) → TTS → audio back to Twilio

Outbound: gateway method → CallManager.initiateCall() → Twilio API → same flow
```

**Two voice modes:**

- **Deepgram hybrid** (`provider: "deepgram"`) — Twilio handles telephony, Deepgram Voice Agent handles STT+LLM+TTS. This is the primary mode. LLM calls are proxied through the OpenClaw gateway.
- **Streaming** (`streaming.enabled: true`) — Twilio + OpenAI Realtime STT + OpenClaw LLM + provider TTS. Legacy mode.

## Key Abstractions

### Plugin Registration (`index.ts`)

- Exports `voiceCallPlugin` with `register(api)` — registers gateway methods, tool, CLI, and service
- **`_sharedRuntime`** — Module-level singleton that survives plugin registry reloads. Gateway methods access the `CallManager` through this. This is intentional: prevents binding the webhook port twice when the loader creates a fresh registry.
- `ensureRuntime()` — Lazy-initializes the runtime on first use

### Runtime (`src/runtime.ts`)

- `createVoiceCallRuntime()` — Wires everything together: resolves provider, creates CallManager, starts webhook server, sets up tunnel, configures Deepgram bridge
- `VoiceCallRuntime` type: `{ config, provider, manager, webhookServer, webhookUrl, publicUrl, stop }`
- Provider resolution: `deepgram` provider actually creates a `TwilioProvider` for telephony + `DeepgramProvider` for voice AI

### Provider Interface (`src/providers/base.ts`)

```typescript
interface VoiceCallProvider {
  name: ProviderName; // "telnyx" | "twilio" | "plivo" | "deepgram" | "mock"
  verifyWebhook(ctx): Result; // Signature/HMAC verification
  parseWebhookEvent(ctx): ParseResult; // Normalize provider events
  initiateCall(input): Promise<Result>; // Start outbound call
  hangupCall(input): Promise<void>;
  playTts(input): Promise<void>; // Speak text to caller
  startListening(input): Promise<void>; // Activate STT
  stopListening(input): Promise<void>;
}
```

Providers: `TwilioProvider` (src/providers/twilio.ts + twilio/), `TelnyxProvider`, `PlivoProvider`, `DeepgramProvider`, `MockProvider`

### Call Manager (`src/manager.ts`)

- **State machine**: `initiated → ringing → answered → active → speaking ⇄ listening → [terminal]`
- Terminal states: `completed`, `hangup-user`, `hangup-bot`, `timeout`, `error`, `failed`, `no-answer`, `busy`, `voicemail`
- `activeCalls` Map + `providerCallIdMap` for O(1) lookups by either internal UUID or provider SID
- Persistence: JSONL append to `~/.openclaw/voice-calls/calls.jsonl`
- Crash recovery: loads active calls on startup, prunes stale ones
- Max duration timer auto-hangups calls after `maxDurationSeconds`
- `continueCall()` — speak prompt, then `waitForFinalTranscript()` (Promise-based)
- Inbound policy: `disabled` | `allowlist` | `pairing` | `open`

### Deepgram Media Bridge (`src/deepgram-media-bridge.ts`)

- Bridges Twilio media stream WebSocket ↔ Deepgram Voice Agent API
- Handles: audio forwarding, barge-in (clear Twilio buffer on user speech), conversation text events, initial greeting injection, notify-mode auto-hangup
- `buildSessionOverrides()` — Configures per-call LLM routing through the gateway with agent-specific context (USER.md, CALLS.md, identity)
- Session key format: `agent:{agentId}:voice:{callSid}`

### Webhook Server (`src/webhook.ts`)

- Raw `http.Server` (not Express/Hono) on port 3334
- Handles: provider webhook POSTs, WebSocket upgrades for media streams and browser voice
- Routes: `config.serve.path` (default `/voice/webhook`), streaming path (`/voice/stream`), browser voice (`/voice/web`)
- Filler phrase injection when LLM response is slow

### Config (`src/config.ts`)

- All Zod schemas: `VoiceCallConfigSchema` (top-level), provider configs, Deepgram latency/fallback, TTS, STT, tunnel, webhook security, outbound modes
- `resolveVoiceCallConfig()` — Merges environment variables into config (TWILIO_ACCOUNT_SID, DEEPGRAM_API_KEY, PUBLIC_URL, etc.)
- `validateProviderConfig()` — Checks required fields per provider
- `resolveAgentForNumber()` / `resolveNumberForAgent()` — Phone number ↔ agent routing

## Gateway Methods

| Method                    | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `voicecall.initiate`      | Start outbound call (to, message, mode)                       |
| `voicecall.continue`      | Speak prompt, wait for user transcript                        |
| `voicecall.speak`         | Speak text to active call                                     |
| `voicecall.end`           | Hang up call                                                  |
| `voicecall.start`         | Simplified initiate (to, message)                             |
| `voicecall.status`        | Get call record by callId or provider SID                     |
| `voicecall.activeCalls`   | List all active calls                                         |
| `voicecall.channelStatus` | Channel health check (configured, running, provider, numbers) |

## File Map

| File                                    | Purpose                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| `index.ts`                              | Plugin entry: gateway methods, tool, CLI, service registration   |
| `src/runtime.ts`                        | Runtime factory: wires provider, manager, webhook, tunnel        |
| `src/config.ts`                         | All Zod config schemas and resolution helpers                    |
| `src/types.ts`                          | Core types: CallRecord, CallState, NormalizedEvent, provider I/O |
| `src/manager.ts`                        | CallManager: state machine, persistence, transcript waiting      |
| `src/webhook.ts`                        | HTTP/WS server for provider callbacks and media streams          |
| `src/deepgram-media-bridge.ts`          | Twilio WS ↔ Deepgram Voice Agent bridge                          |
| `src/media-stream.ts`                   | OpenAI Realtime STT media stream handler (legacy)                |
| `src/providers/base.ts`                 | VoiceCallProvider interface                                      |
| `src/providers/twilio.ts`               | Twilio provider (API calls, webhook parsing, TwiML)              |
| `src/providers/deepgram.ts`             | Deepgram provider (session management)                           |
| `src/providers/deepgram-voice-agent.ts` | Deepgram Voice Agent WebSocket client                            |
| `src/providers/deepgram-fallback.ts`    | Fallback/retry logic for Deepgram sessions                       |
| `src/providers/telnyx.ts`               | Telnyx provider                                                  |
| `src/providers/plivo.ts`                | Plivo provider                                                   |
| `src/providers/mock.ts`                 | Mock provider for testing                                        |
| `src/providers/stt-openai-realtime.ts`  | OpenAI Realtime STT (streaming mode)                             |
| `src/providers/tts-openai.ts`           | OpenAI TTS provider                                              |
| `src/filler.ts`                         | Dynamic filler phrase generation via Claude Haiku                |
| `src/call-summary.ts`                   | Post-call summary generation (writes to CALLS.md)                |
| `src/response-generator.ts`             | LLM response generation for voice                                |
| `src/voice-session-bridge.ts`           | Voice ↔ chat session bridging                                    |
| `src/voice-functions.ts`                | Function calling support for voice                               |
| `src/tunnel.ts`                         | ngrok/Tailscale tunnel management                                |
| `src/webhook-security.ts`               | Forwarding header trust and URL reconstruction                   |
| `src/telephony-tts.ts`                  | Telephony-specific TTS provider wrapper                          |
| `src/telephony-audio.ts`                | Audio format conversion utilities                                |
| `src/allowlist.ts`                      | Phone number allowlist checking                                  |
| `src/voice-mapping.ts`                  | Voice name mapping (OpenAI → Polly, etc.)                        |
| `src/cli.ts`                            | CLI commands for voicecall                                       |
| `src/core-bridge.ts`                    | Bridge to core OpenClaw types (CoreConfig, agent identity)       |
| `src/utils.ts`                          | Path resolution utilities                                        |

## Call Flow (Deepgram Hybrid Mode)

1. **Outbound**: `voicecall.initiate` → `CallManager.initiateCall()` → `TwilioProvider.initiateCall()` (Twilio REST API) → Twilio calls the webhook URL
2. **Webhook**: Twilio POSTs to `/voice/webhook` → `VoiceCallWebhookServer` → `TwilioProvider.parseWebhookEvent()` → normalized events → `CallManager.processEvent()` → TwiML response with `<Stream>` directive
3. **Media stream**: Twilio opens WebSocket to `/voice/stream` → `DeepgramMediaBridge.handleUpgrade()` → creates Deepgram Voice Agent session via `DeepgramProvider.createSession()`
4. **Audio bridge**: Twilio mulaw audio → `DeepgramProvider.sendAudio()` → Deepgram STT → LLM (via gateway `/v1/chat/completions`) → TTS → audio back through bridge → Twilio
5. **Greeting**: After 500ms delay, bridge injects initial message via `client.injectAgentMessage()`
6. **Barge-in**: `userStartedSpeaking` event → sends `{ event: "clear" }` to Twilio to stop playback
7. **End**: Call ends → `handleStop()` → marks call ended → `generateCallSummary()` (fire-and-forget)

## Outbound Call Modes

- **`conversation`** (default) — Full bidirectional voice conversation, stays open until explicit hangup or timeout
- **`notify`** — One-way notification: speaks the message, waits `notifyHangupDelaySec`, then auto-hangups

## Gotchas

- **Extensions are baked into Docker image** — NOT volume-mounted. After editing extension code: `pnpm build && pnpm ui:build && docker build -t openclaw:local . && docker compose up -d openclaw-gateway`
- **`_sharedRuntime` pattern** — Module-level singleton, not on the plugin instance. Gateway methods access it directly from module scope.
- **Deepgram Settings message must be sent before audio** — The `DeepgramVoiceAgentClient` sends the Settings message on WebSocket open, before any audio is forwarded.
- **Provider "deepgram" uses TwilioProvider for telephony** — `resolveProvider()` maps `"deepgram"` to `new TwilioProvider(...)`. The `DeepgramProvider` is created separately and wired via `DeepgramMediaBridge`.
- **Call IDs are dual-keyed** — Internal UUID (`callId`) and provider-specific ID (`providerCallId` / Twilio CallSid). The `providerCallIdMap` enables O(1) lookup by either.
- **Filler phrases** — When LLM response exceeds `fillerThresholdMs`, a filler phrase is generated via Claude Haiku and injected into the Deepgram stream.
- **Post-call summary** — `generateCallSummary()` writes to `{agentWorkspace}/CALLS.md` after each call ends.
