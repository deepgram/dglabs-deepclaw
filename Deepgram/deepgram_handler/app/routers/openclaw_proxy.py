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

        # Kick off dynamic generation in parallel
        if settings.FILLER_DYNAMIC and settings.ANTHROPIC_API_KEY and user_message:

            async def _gen():
                dynamic_phrase_holder[0] = await generate_filler_phrase(
                    user_message, settings.ANTHROPIC_API_KEY
                )

            asyncio.create_task(_gen())

        # Schedule filler injection after threshold
        async def _inject_filler():
            await asyncio.sleep(threshold_ms / 1000)
            phrase = dynamic_phrase_holder[0]
            if not phrase:
                phrases = settings.filler_phrases_list
                phrase = random.choice(phrases) if phrases else None
            if not phrase:
                return
            try:
                logger.info("Injecting filler: %s", phrase)
                await dg_ws.send(
                    json.dumps({"type": "InjectAgentMessage", "message": phrase})
                )
            except Exception:
                logger.debug("Failed to inject filler", exc_info=True)

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
            first_chunk = True
            async for chunk in _filtered_stream(resp.aiter_bytes()):
                if first_chunk and filler_task and not filler_task.done():
                    filler_task.cancel()
                    first_chunk = False
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
