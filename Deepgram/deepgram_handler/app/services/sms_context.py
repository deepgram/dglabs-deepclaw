"""SMS context: detect new vs. known users, build OpenClaw messages, and helpers."""

import asyncio
import logging
from pathlib import Path

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

USER_MD_PATH = Path.home() / ".openclaw" / "workspace" / "USER.md"

SMS_FORMAT_RULES = " Keep responses concise and conversational for texting. A few sentences max."

SMS_CHANNEL_CONTEXT = (
    "IMPORTANT: This message arrived via SMS (Twilio). You are texting with a real person "
    "on their phone. Do NOT say you're on webchat or check your runtime config — "
    "the SMS channel is handled by an external sidecar, not a gateway plugin. "
    "Your replies will be sent back as text messages."
)

NEW_USER_SMS_PROMPT = (
    f"{SMS_CHANNEL_CONTEXT} "
    "You're texting with someone for the first time. "
    "You don't have a name yet — if they ask, say you haven't picked one yet. "
    "Within the first exchange, naturally ask their name. "
    "When someone says 'call me [name]' or 'you can call me [name]', "
    "they are telling you their NAME — not asking you to make a phone call. "
    "If you are asked to text or call, use the twilio action."
    + SMS_FORMAT_RULES
)

KNOWN_USER_SMS_PROMPT = (
    f"{SMS_CHANNEL_CONTEXT} "
    "You're in a text conversation. "
    "If a request is ambiguous, ask a quick clarifying question before acting. "
    "If you are asked to text or call, use the twilio action."
    + SMS_FORMAT_RULES
)

OPENCLAW_URL = "http://localhost:18789/v1/chat/completions"

# Twilio gives ~15s for a webhook reply; leave margin.
TWILIO_REPLY_TIMEOUT = 12.0

# Twilio drops <Message> bodies longer than 1600 characters.
MAX_SMS_LENGTH = 1600

FALLBACK_MESSAGE = "Hey! I'm just getting set up — text me again in a minute and I'll be ready to chat."

HOLDING_MESSAGE = "Give me just a moment to think on that — I'll text you right back."


def build_sms_messages(content: str | list) -> list[dict]:
    """Build the OpenClaw messages list with the appropriate system prompt.

    Checks USER.md to determine if the user is new or known, and prepends
    the matching system prompt.
    """
    try:
        user_context = USER_MD_PATH.read_text().strip()
    except (FileNotFoundError, PermissionError):
        user_context = ""

    if user_context:
        system = f"{KNOWN_USER_SMS_PROMPT}\n\nHere is what you know about this person:\n{user_context}"
    else:
        system = NEW_USER_SMS_PROMPT

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": content},
    ]


def truncate_reply(text: str, limit: int = MAX_SMS_LENGTH) -> str:
    """Truncate *text* to fit within *limit* characters.

    Tries to break at the last newline, then the last sentence-ending
    punctuation (.!?), and falls back to a hard cut with ellipsis.
    """
    if len(text) <= limit:
        return text

    # Leave room for "..." if we need a hard cut.
    window = text[: limit - 3]

    # Prefer a newline break.
    pos = window.rfind("\n")
    if pos > 0:
        return text[:pos].rstrip()

    # Next: last sentence-ending punctuation.
    for i in range(len(window) - 1, -1, -1):
        if window[i] in ".!?":
            return text[: i + 1]

    # Hard cut.
    return window.rstrip() + "..."


async def ask_openclaw(
    settings: Settings,
    session_key: str,
    content: str | list,
) -> str:
    """Send a message to OpenClaw and return the reply text."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            OPENCLAW_URL,
            headers={
                "Authorization": f"Bearer {settings.OPENCLAW_GATEWAY_TOKEN}",
                "x-openclaw-session-key": session_key,
            },
            json={
                "model": settings.AGENT_THINK_MODEL,
                "messages": build_sms_messages(content),
                "stream": False,
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


async def send_delayed_reply(
    task: asyncio.Task[str],
    to_number: str,
) -> None:
    """Wait for an in-flight OpenClaw task, then send the reply as outbound SMS."""
    # Import here to avoid circular dependency (outbound_sms imports config).
    from app.services.outbound_sms import send_sms

    try:
        reply = truncate_reply(await task)
        await send_sms(to=to_number, text=reply)
        logger.info("Delayed SMS sent to %s: %s", to_number, reply[:200])
    except Exception:
        logger.exception("Failed to send delayed SMS to %s", to_number)
