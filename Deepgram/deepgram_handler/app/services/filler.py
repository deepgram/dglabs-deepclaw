"""Dynamic filler phrase generation via Claude Haiku.

Generates short, context-aware phrases to fill dead air during voice calls
while the LLM or tool calls are processing. Falls back gracefully to None
on any failure (timeout, network error, missing API key).
"""

from __future__ import annotations

import asyncio
import logging

import httpx

logger = logging.getLogger(__name__)

HAIKU_MODEL = "claude-haiku-4-5-20251001"
API_URL = "https://api.anthropic.com/v1/messages"
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


async def generate_filler_phrase(user_message: str, api_key: str) -> str | None:
    """Generate a context-aware filler phrase via Claude Haiku.

    Returns the phrase string, or None on any failure.
    """
    if not api_key:
        return None

    try:
        async with asyncio.timeout(HARD_TIMEOUT_S):
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    API_URL,
                    headers={
                        "Content-Type": "application/json",
                        "x-api-key": api_key,
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

                if resp.status_code != 200:
                    logger.warning("Haiku filler returned %d", resp.status_code)
                    return None

                data = resp.json()
                content = data.get("content", [])
                if not content:
                    return None

                text = content[0].get("text", "").strip()
                return text or None

    except (asyncio.TimeoutError, TimeoutError):
        logger.debug("Haiku filler timed out")
        return None
    except Exception:
        logger.debug("Haiku filler failed", exc_info=True)
        return None
