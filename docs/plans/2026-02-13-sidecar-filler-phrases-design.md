# Sidecar Filler Phrases: Design Document

> Branch: `fix/voice-agent-prompting`
> Date: 2026-02-13

## Problem

When the LLM or a tool call takes more than ~1.5 seconds during a voice call, the caller hears dead air. In the Deepgram sidecar, tool calls happen inside OpenClaw (via the think endpoint) and the Python bridge never sees them — it's a pure audio relay. The caller experiences silence while OpenClaw processes.

## Solution

Port the filler phrase system from the TypeScript voice-call extension (`feature/model-selection`) into the Python sidecar. Inject short, contextually relevant phrases ("Let me look into that...", "Checking on that for you...") via Deepgram's `InjectAgentMessage` protocol when the think endpoint response is slow.

## Architecture: Proxy-Based Filler Injection

The TS implementation wraps function call execution with filler timers. In the sidecar, the equivalent moment — OpenClaw executing something slow — manifests as a delayed response on the `/v1/chat/completions` proxy. Every Deepgram think request flows through the Python proxy to OpenClaw. When a tool call makes OpenClaw slow, the proxy request takes >1.5s. That's the trigger.

```
Deepgram Agent
    │
    │ think request (POST /v1/chat/completions)
    ▼
openclaw_proxy.py ──────────────────────────────► OpenClaw (localhost:18789)
    │                                                    │
    ├─ extract session_key from headers                  │ (processing... tool calls...)
    ├─ extract last user message from body               │
    ├─ kick off generate_filler_phrase() async            │
    ├─ start filler timer (1500ms)                       │
    │                                                    │
    │  ┌─ timer fires? ─────────────────────┐            │
    │  │  look up dg_ws via session registry │            │
    │  │  inject filler phrase               │            │
    │  │  (InjectAgentMessage over WS)       │            │
    │  └─────────────────────────────────────┘            │
    │                                                    │
    │◄──────────────── response streams back ────────────┘
    │
    └─ cancel filler timer
    │
    ▼
Deepgram Agent (speaks response via TTS)
```

### Why Proxy-Based (vs. Alternatives)

| Approach                         | Trigger                              | Matches TS?                            | Complexity                                        |
| -------------------------------- | ------------------------------------ | -------------------------------------- | ------------------------------------------------- |
| **Proxy-based** (chosen)         | Slow `/v1/chat/completions` response | Yes — same slow operation trigger      | Medium — session registry + proxy changes         |
| Deepgram event timing            | No agent audio after user speech     | Partially — timing-based, less precise | Low — bridge-only changes                         |
| Register functions with Deepgram | `FunctionCallRequest` WS events      | Closest protocol match                 | High — architecture change, function registration |

The proxy approach mirrors the TS core idea: detect when OpenClaw is slow, inject filler during the wait. It requires a session registry to connect the proxy (which sees the slow request) with the Deepgram WebSocket (which receives the injection).

## Components

### 1. Session Registry (`app/services/session_registry.py`)

Module-level dict mapping `session_key → dg_ws`. Follows the existing pattern in `outbound_call.py` (`_outbound_calls` dict).

```python
_active_sessions: dict[str, Any] = {}

def register(session_key: str, dg_ws) -> None:
    _active_sessions[session_key] = dg_ws

def unregister(session_key: str) -> None:
    _active_sessions.pop(session_key, None)

def get_ws(session_key: str):
    return _active_sessions.get(session_key)
```

**Integration with `deepgram_agent.py`**:

- `run_agent_bridge()` calls `register()` after connecting to Deepgram
- `unregister()` in the `finally` block (cleanup on disconnect)
- Session key is `agent:{AGENT_ID}:{call_id}` (same as the `x-openclaw-session-key` header)

### 2. Filler Module (`app/services/filler.py`)

Port of TS `filler.ts`. Calls Claude Haiku to generate context-aware filler phrases.

**Exported function:**

```python
async def generate_filler_phrase(user_message: str, api_key: str) -> str | None
```

**Key constants:**

- `HAIKU_MODEL = "claude-haiku-4-5-20251001"`
- `API_URL = "https://api.anthropic.com/v1/messages"`
- `HARD_TIMEOUT_MS = 2.0` (seconds, for asyncio)
- `MAX_TOKENS = 50`

**Prompt** (user message variant, since we don't have tool name/args at the proxy level):

```
You're a voice assistant on a phone call. The user just said: "{user_message}".
You need a moment to think. Generate a single short "thinking" phrase (under 10 words)
that shows you're considering their specific question -- not a generic acknowledgment.
BAD: "Got it." "Sure thing." "Absolutely." (these sound like the real answer starting)
GOOD: "Hmm, good question." "Let me think about that." "Oh interesting, one sec."
Output ONLY the phrase. End with a period.
```

**Error handling**: Any failure (timeout, network error, missing key, malformed response) returns `None`. Uses `httpx.AsyncClient` with `asyncio.timeout(2.0)` for the hard timeout.

### 3. Proxy Instrumentation (`app/routers/openclaw_proxy.py`)

The `proxy_chat_completions` handler gains filler logic:

```python
@router.api_route("/v1/chat/completions", methods=["POST"])
async def proxy_chat_completions(request: Request):
    body = await request.body()
    headers = { ... }  # existing header filtering

    # --- Filler setup ---
    settings = get_settings()
    session_key = request.headers.get("x-openclaw-session-key")
    dg_ws = get_ws(session_key) if session_key else None
    threshold_ms = settings.FILLER_THRESHOLD_MS

    filler_task = None
    dynamic_phrase_holder = [None]  # mutable container for closure
    filler_fired = False

    if dg_ws and threshold_ms > 0:
        # Extract last user message for dynamic filler context
        user_message = _extract_last_user_message(body)

        # Kick off dynamic generation in parallel
        if settings.FILLER_DYNAMIC and settings.ANTHROPIC_API_KEY and user_message:
            async def _gen():
                dynamic_phrase_holder[0] = await generate_filler_phrase(
                    user_message, settings.ANTHROPIC_API_KEY
                )
            asyncio.create_task(_gen())

        # Schedule filler injection
        async def _inject_filler():
            await asyncio.sleep(threshold_ms / 1000)
            phrase = dynamic_phrase_holder[0]
            if not phrase:
                phrases = settings.filler_phrases_list
                phrase = random.choice(phrases) if phrases else None
            if phrase:
                await dg_ws.send(json.dumps({"type": "InjectAgentMessage", "message": phrase}))

        filler_task = asyncio.create_task(_inject_filler())

    # --- Forward to OpenClaw (existing logic) ---
    client = httpx.AsyncClient(timeout=...)
    resp = await client.send(req, stream=True)

    async def stream_body():
        try:
            first = True
            async for chunk in _filtered_stream(resp.aiter_bytes()):
                if first and filler_task:
                    filler_task.cancel()  # Cancel filler on first response bytes
                    first = False
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(content=stream_body(), ...)
```

**`_extract_last_user_message(body)`**: Parses the JSON request body, finds the last message with `role: "user"`, extracts its text content. Returns `str | None`.

### 4. Configuration

New fields on `Settings` in `app/config.py`:

```python
# Filler phrases
FILLER_THRESHOLD_MS: int = 1500
FILLER_PHRASES: str = ""  # Comma-separated static fallback phrases
FILLER_DYNAMIC: bool = True
ANTHROPIC_API_KEY: str = ""  # Already in env for OpenClaw; reused for Haiku

@property
def filler_phrases_list(self) -> list[str]:
    """Parse comma-separated FILLER_PHRASES into a list."""
    if not self.FILLER_PHRASES:
        return []
    return [p.strip() for p in self.FILLER_PHRASES.split(",") if p.strip()]
```

| Setting               | Type   | Default | Description                                  |
| --------------------- | ------ | ------- | -------------------------------------------- |
| `FILLER_THRESHOLD_MS` | `int`  | `1500`  | Delay before injecting filler. `0` disables. |
| `FILLER_PHRASES`      | `str`  | `""`    | Comma-separated static fallback phrases      |
| `FILLER_DYNAMIC`      | `bool` | `True`  | Enable Haiku-generated context-aware fillers |
| `ANTHROPIC_API_KEY`   | `str`  | `""`    | API key for Haiku calls (already in env)     |

### 5. Injection Protocol

Filler injection uses Deepgram's `InjectAgentMessage`:

```python
await dg_ws.send(json.dumps({"type": "InjectAgentMessage", "message": phrase}))
```

This causes Deepgram to speak the phrase through its TTS pipeline immediately, using the same voice as the agent's normal responses. Deepgram may refuse injection if the user is speaking or the agent is already responding — this is safe and expected.

### 6. Cancellation

**Before filler fires**: If the OpenClaw response starts streaming before the threshold, `filler_task.cancel()` prevents injection. The caller gets a seamless, fast response.

**After filler is speaking**: If the filler is already being spoken when the real response arrives, Deepgram handles this naturally — it queues the real response after the filler. No explicit cancellation needed.

**Barge-in**: If the user speaks during filler playback, Deepgram detects `UserStartedSpeaking` and the bridge sends a clear event to Twilio (existing behavior), cutting off the filler.

### 7. Timing

```
t=0ms        Deepgram sends think request to proxy
             generate_filler_phrase() kicks off in parallel
             Request forwarded to OpenClaw

t=1500ms     Filler timer fires
             Check: has response started streaming? (task cancelled?)
               YES → do nothing (task was cancelled)
               NO  → inject filler
                     prefer dynamic phrase if Haiku returned by now
                     else pick random static phrase
                     else do nothing (no phrases configured)

t=2000ms     HARD_TIMEOUT for Haiku (if still pending, aborted)

t=???        OpenClaw response starts streaming
             Cancel filler timer (if not yet fired)
             Deepgram receives response, generates TTS
```

## Files Changed

| File                               | Change                                             |
| ---------------------------------- | -------------------------------------------------- |
| `app/services/session_registry.py` | **New** — session key → dg_ws mapping              |
| `app/services/filler.py`           | **New** — Haiku dynamic filler generation          |
| `app/services/deepgram_agent.py`   | Register/unregister sessions in `run_agent_bridge` |
| `app/routers/openclaw_proxy.py`    | Filler timer + injection logic in proxy handler    |
| `app/config.py`                    | Add `FILLER_*` and `ANTHROPIC_API_KEY` settings    |
| `tests/test_filler.py`             | **New** — filler generation tests                  |
| `tests/test_session_registry.py`   | **New** — registry tests                           |
| `tests/test_openclaw_proxy.py`     | Extend with filler injection tests                 |
| `tests/test_deepgram_agent.py`     | Test session registration/unregistration           |
| `tests/conftest.py`                | Add default env vars for new settings              |

## Out of Scope

- `generateFillerSet` (multi-phrase escalation) — exported but unused in TS, skip for now
- Outbound call fillers — outbound calls use isolated sessions with different prompts; filler support can be added later
- Filler metrics/events — the TS version emits `fillerInjected` events; skip for now since the sidecar has no event bus
