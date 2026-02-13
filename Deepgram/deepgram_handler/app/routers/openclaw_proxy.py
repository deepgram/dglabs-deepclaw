"""Reverse proxy for OpenClaw gateway.

Forwards /v1/chat/completions requests to the local OpenClaw gateway
so that external callers (e.g., Deepgram) can reach it on the standard
HTTPS port without needing a dedicated IP for a non-standard port.
"""

import asyncio
import json
import logging
import random
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.services.filler import generate_filler_phrase
from app.services.session_registry import get_ws

logger = logging.getLogger(__name__)

router = APIRouter(tags=["openclaw-proxy"])

OPENCLAW_BASE = "http://localhost:18789"

# OpenClaw injects these markers into the conversation history sent to the
# LLM.  Smaller models sometimes echo them back in their response, which is
# harmless in text but gets spoken aloud by TTS.  We strip them at the byte
# level so they never reach Deepgram.
_STRIP_MARKERS: list[bytes] = [
    b"[Current message - respond to this]",
    b"[Chat messages since your last reply - for context]",
]
_MAX_MARKER_LEN = max(len(m) for m in _STRIP_MARKERS)


async def _filtered_stream(raw_stream: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Yield bytes from *raw_stream* with known marker strings removed.

    Uses a small carry-over buffer (len = longest marker - 1) so that
    markers spanning chunk boundaries are caught while adding negligible
    latency.
    """
    buf = b""
    async for chunk in raw_stream:
        buf += chunk
        # Replace any complete marker occurrences in the buffer.
        for marker in _STRIP_MARKERS:
            buf = buf.replace(marker, b"")
        # Everything except the last (_MAX_MARKER_LEN - 1) bytes is safe to
        # emit — a partial marker can only start in that trailing window.
        safe_end = len(buf) - (_MAX_MARKER_LEN - 1)
        if safe_end > 0:
            yield buf[:safe_end]
            buf = buf[safe_end:]
    # Flush the remainder.
    for marker in _STRIP_MARKERS:
        buf = buf.replace(marker, b"")
    if buf:
        yield buf


def _extract_last_user_message(body: bytes) -> str | None:
    """Extract the last user message text from an OpenAI-format request body."""
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return None

    messages = data.get("messages", [])
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    return part.get("text")
        return None
    return None


def _chunk_has_content(chunk: bytes) -> bool:
    """Check if an SSE chunk contains actual assistant text content.

    SSE streaming chat completions send an initial chunk with just
    ``{"delta": {"role": "assistant"}}`` before any real text.  We only
    want to cancel the filler timer when the LLM has started producing
    actual answer text — i.e. ``"content": "<non-empty>"``.
    """
    idx = chunk.find(b'"content":"')
    if idx == -1:
        return False
    # Position right after the opening quote of the value.
    after = idx + len(b'"content":"')
    # Non-empty content means the next byte is NOT a closing quote.
    return after < len(chunk) and chunk[after : after + 1] != b'"'


@router.api_route("/v1/chat/completions", methods=["POST"])
async def proxy_chat_completions(request: Request):
    """Proxy POST /v1/chat/completions to the local OpenClaw gateway.

    Injects filler phrases via Deepgram InjectAgentMessage when the
    response takes longer than FILLER_THRESHOLD_MS.
    """
    body = await request.body()
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "transfer-encoding")
    }

    # --- Filler setup ---
    settings = get_settings()
    session_key = request.headers.get("x-openclaw-session-key")
    dg_ws = get_ws(session_key) if session_key else None
    threshold_ms = settings.FILLER_THRESHOLD_MS

    filler_task: asyncio.Task | None = None

    if dg_ws and threshold_ms > 0:
        user_message = _extract_last_user_message(body)
        dynamic_phrase_holder: list[str | None] = [None]
        logger.info(
            "Filler armed: threshold=%dms dynamic=%s user_msg=%s",
            threshold_ms,
            settings.FILLER_DYNAMIC,
            repr(user_message[:60]) if user_message else None,
        )

        # Kick off dynamic generation in parallel
        dynamic_started = False
        if settings.FILLER_DYNAMIC and settings.OPENCLAW_GATEWAY_TOKEN and user_message:
            dynamic_started = True

            async def _gen():
                phrase = await generate_filler_phrase(
                    user_message, settings.OPENCLAW_GATEWAY_TOKEN
                )
                dynamic_phrase_holder[0] = phrase
                logger.info("Dynamic filler ready: %s", phrase)

            asyncio.create_task(_gen())

        # Schedule filler injection after threshold
        async def _inject_filler():
            await asyncio.sleep(threshold_ms / 1000)
            phrase = dynamic_phrase_holder[0]
            if phrase:
                logger.info("Dynamic filler available at threshold: %s", phrase)
            elif dynamic_started:
                # Grace period: wait up to 500ms more for the dynamic phrase
                logger.info("Dynamic filler not ready at threshold, waiting up to 500ms...")
                for _ in range(5):
                    await asyncio.sleep(0.1)
                    phrase = dynamic_phrase_holder[0]
                    if phrase:
                        logger.info("Dynamic filler arrived during grace period: %s", phrase)
                        break
            if not phrase:
                phrases = settings.filler_phrases_list
                phrase = random.choice(phrases) if phrases else None
                if phrase:
                    logger.info("Falling back to static filler: %s", phrase)
                else:
                    logger.warning(
                        "No filler phrase available (dynamic=None, static list empty), skipping injection"
                    )
            if not phrase:
                return
            try:
                logger.info("Injecting filler phrase: %s", phrase)
                await dg_ws.send(
                    json.dumps({"type": "InjectAgentMessage", "message": phrase})
                )
                logger.info("Filler phrase injected successfully")
            except Exception:
                logger.warning("Failed to inject filler phrase", exc_info=True)

        filler_task = asyncio.create_task(_inject_filler())

    # --- Forward to OpenClaw ---
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10, read=120, write=10, pool=10)
    )
    req = client.build_request(
        "POST",
        f"{OPENCLAW_BASE}/v1/chat/completions",
        content=body,
        headers=headers,
    )
    resp = await client.send(req, stream=True)

    async def stream_body():
        try:
            filler_cancelled = False
            async for chunk in _filtered_stream(resp.aiter_bytes()):
                # Cancel filler only when real content text starts streaming.
                # SSE streams send an initial chunk with just {"delta":{"role":"..."}}
                # before any actual text — cancelling on that would kill the filler
                # even when the real response takes 10+ seconds (e.g. web search).
                if (
                    not filler_cancelled
                    and filler_task
                    and not filler_task.done()
                    and _chunk_has_content(chunk)
                ):
                    filler_task.cancel()
                    filler_cancelled = True
                    logger.info("Filler cancelled: real content arrived")
                yield chunk
        finally:
            if filler_task and not filler_task.done():
                filler_task.cancel()
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        content=stream_body(),
        status_code=resp.status_code,
        headers=dict(resp.headers),
    )
