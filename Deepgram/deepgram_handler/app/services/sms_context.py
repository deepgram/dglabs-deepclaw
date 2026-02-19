"""SMS context: detect new vs. known users, build OpenClaw messages, and helpers."""

import asyncio
import json
import logging
from pathlib import Path

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace"
USER_MD_PATH = WORKSPACE_DIR / "USER.md"
CALLS_MD_PATH = WORKSPACE_DIR / "test-voice-agent" / "CALLS.md"
TEXTS_MD_PATH = WORKSPACE_DIR / "TEXTS.md"

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
    "If you are asked to text or call, use the twilio action. "
    "CRITICAL — TOOL CALL ORDERING: You have a 12-second window to reply before a generic "
    "holding message is sent automatically. If you need to call ANY tool (search, reddit, "
    "web lookup, spawn, etc.), you MUST call status_update FIRST as a separate tool call "
    "with a brief heads-up like 'Looking into that now...' BEFORE calling the slow tool. "
    "This sends the person an immediate text so they know you're working on it. "
    "If you skip status_update and go straight to a slow tool, the person gets an ugly "
    "generic 'give me a moment' message instead of your personalized update. "
    "Always: status_update first, then the actual tool."
    + SMS_FORMAT_RULES
)

KNOWN_USER_SMS_PROMPT = (
    f"{SMS_CHANNEL_CONTEXT} "
    "You're in a text conversation. "
    "If a request is ambiguous, ask a quick clarifying question before acting. "
    "If you are asked to text or call, use the twilio action. "
    "CRITICAL — TOOL CALL ORDERING: You have a 12-second window to reply before a generic "
    "holding message is sent automatically. If you need to call ANY tool (search, reddit, "
    "web lookup, spawn, etc.), you MUST call status_update FIRST as a separate tool call "
    "with a brief heads-up like 'Searching for that now...' BEFORE calling the slow tool. "
    "This sends the person an immediate text so they know you're working on it. "
    "If you skip status_update and go straight to a slow tool, the person gets an ugly "
    "generic 'give me a moment' message instead of your personalized update. "
    "Always: status_update first, then the actual tool."
    + SMS_FORMAT_RULES
)

OPENCLAW_URL = "http://localhost:18789/v1/chat/completions"

# Twilio gives ~15s for a webhook reply; leave margin.
TWILIO_REPLY_TIMEOUT = 12.0

# Twilio drops <Message> bodies longer than 1600 characters.
MAX_SMS_LENGTH = 1600

FALLBACK_MESSAGE = "Hey! I'm just getting set up — text me again in a minute and I'll be ready to chat."

HOLDING_MESSAGE = "Give me just a moment to think on that — I'll text you right back."


def _read_file(path: Path) -> str | None:
    """Read a file, returning None if missing or empty."""
    try:
        text = path.read_text().strip()
        return text or None
    except (FileNotFoundError, PermissionError):
        return None


def build_sms_messages(content: str | list) -> list[dict]:
    """Build the OpenClaw messages list with the appropriate system prompt.

    Checks USER.md to determine if the user is new or known, and includes
    recent session history from CALLS.md and TEXTS.md.
    """
    from app.services.user_md_parser import parse_calls_md

    user_context = _read_file(USER_MD_PATH) or ""

    if user_context:
        system = f"{KNOWN_USER_SMS_PROMPT}\n\nHere is what you know about this person:\n{user_context}"
    else:
        system = NEW_USER_SMS_PROMPT

    # Append recent session history (calls + texts)
    history_parts: list[str] = []

    calls_md = _read_file(CALLS_MD_PATH)
    if calls_md:
        recent_calls = parse_calls_md(calls_md, count=3)
        if recent_calls:
            history_parts.append("Recent calls:")
            for entry in recent_calls:
                for line in entry.split("\n"):
                    history_parts.append(f"  {line}")

    texts_md = _read_file(TEXTS_MD_PATH)
    if texts_md:
        recent_texts = parse_calls_md(texts_md, count=3)
        if recent_texts:
            history_parts.append("Recent texts:")
            for entry in recent_texts:
                for line in entry.split("\n"):
                    history_parts.append(f"  {line}")

    if history_parts:
        system += "\n\n" + "\n".join(history_parts)

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
    """Send a request to OpenClaw and return the final reply text.

    Uses ``stream: True`` so the HTTP connection stays alive for the full
    duration of the agent run (which can involve multiple tool calls over
    several minutes).  The SSE stream is consumed but only the text content
    is accumulated — intermediate delivery is handled separately by the
    gateway WebSocket subscription in the SMS router.

    The timeout is generous (10 minutes) because the Twilio webhook deadline
    is handled separately.
    """
    headers = {
        "Authorization": f"Bearer {settings.OPENCLAW_GATEWAY_TOKEN}",
        "x-openclaw-session-key": session_key,
    }
    timeout = httpx.Timeout(connect=10, read=600, write=10, pool=10)

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            OPENCLAW_URL,
            headers=headers,
            json={
                "model": settings.AGENT_THINK_MODEL,
                "messages": build_sms_messages(content),
                "stream": True,
            },
        ) as resp:
            resp.raise_for_status()
            logger.info("[sms] SSE stream opened for %s", session_key)

            text_parts: list[str] = []

            async for raw_line in resp.aiter_lines():
                if not raw_line.startswith("data: "):
                    continue
                payload = raw_line[6:]
                if payload == "[DONE]":
                    break

                try:
                    data = json.loads(payload)
                except json.JSONDecodeError:
                    continue

                for choice in data.get("choices", []):
                    chunk = choice.get("delta", {}).get("content")
                    if chunk:
                        text_parts.append(chunk)

            reply = "".join(text_parts).strip()
            logger.info("[sms] SSE done for %s (%d chars)", session_key, len(reply))
            return reply


async def send_delayed_reply(
    task: asyncio.Task[str],
    to_number: str,
    from_number: str | None = None,
) -> None:
    """Wait for an in-flight OpenClaw task, then send the reply as outbound SMS.

    Used by the control-plane proxy router (``proxy.py``).
    """
    from app.services.outbound_sms import send_sms

    try:
        reply = truncate_reply(await task)
        if reply:
            await send_sms(to=to_number, text=reply, from_number=from_number)
            logger.info("Delayed SMS sent to %s: %s", to_number, reply[:200])
        else:
            logger.info("Delayed SMS skipped for %s — empty reply", to_number)
    except Exception:
        logger.exception("Failed to send delayed SMS to %s", to_number)
