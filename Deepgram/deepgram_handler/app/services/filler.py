"""Dynamic filler phrase generation via Claude Haiku.

Generates short, context-aware phrases to fill dead air during voice calls
while the LLM or tool calls are processing. Routes through the local OpenClaw
gateway (which handles LLM provider auth). Falls back gracefully to None on
any failure (timeout, network error, missing token).
"""

from __future__ import annotations

import asyncio
import logging

import httpx

logger = logging.getLogger(__name__)

HAIKU_MODEL = "litellm/claude-haiku-4-5-20251001"
GATEWAY_URL = "http://localhost:18789/v1/chat/completions"
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


async def generate_filler_phrase(user_message: str, gateway_token: str) -> str | None:
    """Generate a context-aware filler phrase via Claude Haiku.

    Routes through the local OpenClaw gateway so we inherit its LLM
    provider auth rather than needing a direct Anthropic API key.

    Returns the phrase string, or None on any failure.
    """
    if not gateway_token:
        logger.warning("No gateway token for filler generation, skipping")
        return None

    logger.info(
        "Haiku filler: starting request (model=%s url=%s timeout=%.1fs)",
        HAIKU_MODEL, GATEWAY_URL, HARD_TIMEOUT_S,
    )
    try:
        async with asyncio.timeout(HARD_TIMEOUT_S):
            async with httpx.AsyncClient() as client:
                logger.info("Haiku filler: sending POST to gateway...")
                resp = await client.post(
                    GATEWAY_URL,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {gateway_token}",
                    },
                    json={
                        "model": HAIKU_MODEL,
                        "max_tokens": MAX_TOKENS,
                        "stream": False,
                        "messages": [
                            {"role": "user", "content": _build_prompt(user_message)}
                        ],
                    },
                    timeout=HARD_TIMEOUT_S,
                )

                logger.info(
                    "Haiku filler: gateway responded %d (%d bytes)",
                    resp.status_code, len(resp.content),
                )
                if resp.status_code != 200:
                    logger.warning(
                        "Haiku filler: bad status %d — body: %s",
                        resp.status_code, resp.text[:200],
                    )
                    return None

                data = resp.json()
                choices = data.get("choices", [])
                if not choices:
                    logger.warning("Haiku filler: no choices in response: %s", data)
                    return None

                text = choices[0].get("message", {}).get("content", "").strip()
                if text:
                    logger.info("Haiku filler: generated phrase: %s", text)
                else:
                    logger.warning("Haiku filler: empty content in response")
                return text or None

    except (asyncio.TimeoutError, TimeoutError):
        logger.warning("Haiku filler: timed out after %.1fs waiting for gateway", HARD_TIMEOUT_S)
        return None
    except Exception:
        logger.warning("Haiku filler: unexpected error", exc_info=True)
        return None
