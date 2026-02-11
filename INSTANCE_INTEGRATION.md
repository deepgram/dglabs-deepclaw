# Instance Voice Integration Guide

How to implement the voice stream endpoint on a backend instance (e.g. dglabs-deepclaw) so that the DeepClaw control plane can relay phone and browser voice calls to it.

## Overview

```
Phone caller → Twilio → Control Plane (relay) → Instance /voice/stream
                                                    ↕
Browser      ─────────→ Control Plane (relay) → Instance /voice/stream
```

The control plane is a **transparent relay**. It does not decode audio, create voice agents, or interpret any frames. It forwards raw Twilio or browser frames verbatim to your instance's `/voice/stream` WebSocket and relays responses back.

Your instance is responsible for:

- Creating and managing the voice agent (STT, TTS, turn-taking, etc.)
- Processing inbound audio and generating outbound audio
- Routing LLM requests through LiteLLM (credentials provided via env vars)
- Handling barge-in, conversation state, and cleanup

---

## 1. WebSocket endpoint

Expose a WebSocket endpoint that the control plane will connect to:

```
GET /voice/stream  →  WebSocket upgrade
```

The path is configurable on the control plane via `VOICE_STREAM_PATH` (default: `/voice/stream`).

### Connection headers

The control plane sends these headers on the WebSocket upgrade request:

| Header                     | Type                      | Description                                                              |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `X-DeepClaw-User-Id`       | UUID string               | The user's ID                                                            |
| `X-DeepClaw-Call-Sid`      | string                    | Twilio `CallSid` (e.g. `CA1234...`) or `browser-{hex}` for browser calls |
| `X-DeepClaw-Phone-Number`  | string                    | Caller's phone number in E.164 format                                    |
| `X-DeepClaw-Stream-Format` | `"twilio"` or `"browser"` | Which framing protocol the client uses                                   |
| `fly-force-instance-id`    | string                    | Fly machine ID for request pinning (absent in local mode)                |
| `Origin`                   | URL string                | `https://{app}.fly.dev` or localhost URL                                 |

---

## 2. Twilio format (`X-DeepClaw-Stream-Format: twilio`)

All frames are **JSON text frames** following [Twilio's Media Streams protocol](https://www.twilio.com/docs/voice/media-streams/websocket-messages). The control plane forwards them verbatim — it does not parse or transform them.

### Inbound frames (control plane → instance)

```jsonc
// 1. Connected event
{"event": "connected", "protocol": "Call", "version": "1.0.0"}

// 2. Start event (contains streamSid, callSid, audio format metadata)
{
  "event": "start",
  "start": {
    "streamSid": "MZ...",
    "callSid": "CA...",
    "accountSid": "AC...",
    "tracks": ["inbound"],
    "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1}
  }
}

// 3. Media events (continuous — base64-encoded mulaw audio)
{"event": "media", "media": {"payload": "<base64 mulaw>", "track": "inbound", ...}}

// 4. Stop event (call ended)
{"event": "stop", "stop": {"accountSid": "AC...", "callSid": "CA..."}}
```

The control plane buffers `connected` and `start` frames and replays them once the upstream connection opens, so your endpoint receives the full handshake.

### Outbound frames (instance → control plane)

Send JSON text frames. They are forwarded verbatim to Twilio:

```jsonc
// Audio to caller (base64 mulaw)
{"event": "media", "streamSid": "<from start>", "media": {"payload": "<base64 mulaw>"}}

// Clear buffered audio (e.g. for barge-in)
{"event": "clear", "streamSid": "<from start>"}
```

---

## 3. Browser format (`X-DeepClaw-Stream-Format: browser`)

### Inbound frames (control plane → instance)

```
Binary frame:  raw linear16 PCM audio, 16 kHz, mono
Text frame:    {"type": "stop"}
```

### Outbound frames (instance → control plane)

```
Binary frame:  raw linear16 PCM audio
Text frame:    {"type": "clear"}
Text frame:    {"type": "transcript", "role": "user"|"assistant", "content": "..."}  (optional)
```

---

## 4. Environment variables

The control plane passes these env vars to each instance at provisioning time:

| Env var                  | Description                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | LiteLLM virtual key (budget-limited, model-scoped)          |
| `ANTHROPIC_BASE_URL`     | LiteLLM proxy URL (e.g. `https://deepclaw-litellm.fly.dev`) |
| `DEEPGRAM_API_KEY`       | Deepgram API key                                            |
| `OPENCLAW_GATEWAY_TOKEN` | Auth token for the OpenClaw gateway                         |

The instance should use `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` for all LLM requests. These route through LiteLLM, which enforces per-user budgets and model access before forwarding to Anthropic.

---

## 5. Lifecycle

### Phone call (Twilio)

1. Caller dials in → Twilio hits control plane `POST /api/twilio/inbound`
2. Control plane checks if user has a running machine
   - **No machine**: returns `<Say>` TwiML — instance is never contacted
   - **Machine running**: returns `<Connect><Stream>` TwiML
3. Twilio opens WS to control plane → control plane opens WS to `/voice/stream` with headers
4. Twilio frames flow verbatim in both directions
5. Instance creates a voice agent, processes audio, sends responses
6. Either side closes → both WebSockets tear down

### Browser call

1. Browser opens `WS /api/me/voice?token=<token>`
2. Control plane authenticates, loads user's machine
   - **No machine**: closes with code `4002`
   - **Machine running**: opens WS to `/voice/stream` with `X-DeepClaw-Stream-Format: browser`
3. Binary audio and text control frames flow verbatim in both directions

---

## 6. Error handling

| Scenario                                        | What happens                                         |
| ----------------------------------------------- | ---------------------------------------------------- |
| Instance `/voice/stream` rejects the connection | Control plane closes the client WS                   |
| Instance closes its WS                          | Control plane closes the client WS                   |
| Client disconnects                              | Control plane closes the upstream WS to the instance |

---

## 7. Ports and URLs

- The control plane derives the upstream URL from the machine's `machine_url` + `VOICE_STREAM_PATH`
- `https://deepclaw-instance.fly.dev` → `wss://deepclaw-instance.fly.dev/voice/stream`
- `http://localhost:18789` → `ws://localhost:18789/voice/stream`

---

## 8. Testing locally

1. Run your instance with `/voice/stream` on localhost
2. Set control plane env vars:
   ```
   LOCAL_MODE=true
   LOCAL_OPENCLAW_URL=http://localhost:18789
   ```
3. Use ngrok to expose the control plane for Twilio
4. Call the Twilio number → control plane relays to your local instance

---

## 9. Quick reference

| Component                      | URL/Path                           |
| ------------------------------ | ---------------------------------- |
| Voice stream (instance)        | `GET /voice/stream` → WS           |
| LiteLLM (shared infra)         | `https://deepclaw-litellm.fly.dev` |
| Twilio inbound (control plane) | `POST /api/twilio/inbound`         |
| Browser voice (control plane)  | `WS /api/me/voice?token=<token>`   |
