"""Dynamic filler phrase generation via Claude Haiku (direct Anthropic API).

Generates short, context-aware phrases to fill dead air during voice calls
while the LLM or tool calls are processing. Calls the Anthropic Messages API
directly (bypassing the local gateway) so the request doesn't get queued
behind the main LLM call that's causing the delay in the first place.

Falls back gracefully to None on any failure (timeout, network error,
missing API key).
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

logger = logging.getLogger(__name__)

HAIKU_MODEL = "claude-haiku-4-5-20251001"
HARD_TIMEOUT_S = 2.0
MAX_TOKENS = 50


def _build_prompt(user_message: str) -> str:
    return (
        f'You\'re a voice assistant on a phone call. The user just said: "{user_message}". '
        'You need a moment to think. Generate a single short "thinking" phrase (under 10 words) '
        "that shows you're considering their specific question -- not a generic acknowledgment.\n"
        'BAD: "Got it." "Sure thing." "Absolutely." (these sound like the real answer starting)\n'
        'GOOD: "Hmm, good question." "Let me think about that." "Oh interesting, one sec."\n'
        "Output ONLY the phrase. End with a period."
    )


async def generate_filler_phrase(
    user_message: str,
    anthropic_api_key: str,
    base_url: str = "https://api.anthropic.com",
) -> str | None:
    """Generate a context-aware filler phrase via Claude Haiku.

    Calls the Anthropic Messages API directly so the request bypasses the
    local gateway (which is busy with the main LLM call).

    Returns the phrase string, or None on any failure.
    """
    if not anthropic_api_key:
        logger.warning("Haiku filler: no ANTHROPIC_API_KEY set, skipping")
        return None

    url = f"{base_url.rstrip('/')}/v1/messages"
    t0 = time.monotonic()
    logger.info(
        "Haiku filler: starting direct Anthropic request (model=%s url=%s timeout=%.1fs)",
        HAIKU_MODEL, url, HARD_TIMEOUT_S,
    )
    try:
        async with asyncio.timeout(HARD_TIMEOUT_S):
            async with httpx.AsyncClient() as client:
                logger.info("Haiku filler: sending POST to %s ...", url)
                resp = await client.post(
                    url,
                    headers={
                        "Content-Type": "application/json",
                        "x-api-key": anthropic_api_key,
                        "anthropic-version": "2023-06-01",
                    },
                    json={
                        "model": HAIKU_MODEL,
                        "max_tokens": MAX_TOKENS,
                        "messages": [
                            {"role": "user", "content": _build_prompt(user_message)}
                        ],
                    },
                    timeout=HARD_TIMEOUT_S,
                )

                elapsed_ms = (time.monotonic() - t0) * 1000
                logger.info(
                    "Haiku filler: Anthropic responded %d (%d bytes) in %.0fms",
                    resp.status_code, len(resp.content), elapsed_ms,
                )
                if resp.status_code != 200:
                    logger.warning(
                        "Haiku filler: bad status %d — body: %s",
                        resp.status_code, resp.text[:300],
                    )
                    return None

                data = resp.json()

                # Anthropic Messages API returns {"content": [{"type": "text", "text": "..."}]}
                content_blocks = data.get("content", [])
                if not content_blocks:
                    logger.warning("Haiku filler: no content blocks in response: %s", data)
                    return None

                text = ""
                for block in content_blocks:
                    if block.get("type") == "text":
                        text = block.get("text", "").strip()
                        break

                if text:
                    logger.info("Haiku filler: generated phrase in %.0fms: %s", elapsed_ms, text)
                else:
                    logger.warning("Haiku filler: empty text in response: %s", data)
                return text or None

    except (asyncio.TimeoutError, TimeoutError):
        elapsed_ms = (time.monotonic() - t0) * 1000
        logger.warning("Haiku filler: timed out after %.0fms (limit=%.1fs)", elapsed_ms, HARD_TIMEOUT_S)
        return None
    except Exception:
        elapsed_ms = (time.monotonic() - t0) * 1000
        logger.warning("Haiku filler: unexpected error after %.0fms", elapsed_ms, exc_info=True)
        return None
