"""Reverse proxy for OpenClaw gateway.

Forwards /v1/chat/completions requests to the local OpenClaw gateway
so that external callers (e.g., Deepgram) can reach it on the standard
HTTPS port without needing a dedicated IP for a non-standard port.
"""

import logging
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

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


@router.api_route("/v1/chat/completions", methods=["POST"])
async def proxy_chat_completions(request: Request):
    """Proxy POST /v1/chat/completions to the local OpenClaw gateway."""
    body = await request.body()
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "transfer-encoding")
    }

    client = httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=120, write=10, pool=10))
    req = client.build_request(
        "POST",
        f"{OPENCLAW_BASE}/v1/chat/completions",
        content=body,
        headers=headers,
    )
    resp = await client.send(req, stream=True)

    async def stream_body():
        try:
            async for chunk in _filtered_stream(resp.aiter_bytes()):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        content=stream_body(),
        status_code=resp.status_code,
        headers=dict(resp.headers),
    )
