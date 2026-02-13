"""Deepgram Voice Agent bridge.

Connects to Deepgram's agent WebSocket and relays audio bidirectionally
with a Twilio media stream WebSocket.
"""

import asyncio
import json
import logging
import os
import uuid
from pathlib import Path

import httpx

from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from app.config import Settings, get_settings
from app.services.twilio_media import (
    build_clear_event,
    build_media_event,
    extract_audio_from_media_event,
    parse_twilio_event,
)

logger = logging.getLogger(__name__)

USER_MD_PATH = Path.home() / ".openclaw" / "workspace" / "USER.md"
NEXT_GREETING_PATH = Path.home() / ".openclaw" / "workspace" / "NEXT_GREETING.txt"

VOICE_FORMAT_RULES = (
    "IMPORTANT: Your responses will be spoken aloud via text-to-speech. Do NOT use any text formatting — "
    "no markdown, no bullet points, no asterisks, no numbered lists, no headers. "
    "Write plain conversational sentences only. "
    "Keep responses brief and conversational (1-2 sentences max). "
    'Do NOT start your response with filler phrases like "Let me check" or "One moment" — '
    "that is handled automatically. Jump straight into the answer."
    "If you are asked to text or call, use the twilio action"

)

KNOWN_USER_PROMPT = (
    f"You are on a phone call. {VOICE_FORMAT_RULES} "
    "If a request is ambiguous or you're unsure what the caller means, ask a quick clarifying question "
    "before acting. Don't guess or add requirements they didn't ask for."
    "If you are asked to text or call, use the twilio action"

)


def _read_user_context() -> str | None:
    """Read USER.md from the home directory if it exists."""
    try:
        content = USER_MD_PATH.read_text().strip()
        if content:
            return content
    except (FileNotFoundError, PermissionError):
        pass
    return None


def _read_next_greeting() -> str | None:
    """Read the pre-generated greeting for the next call, if it exists."""
    try:
        content = NEXT_GREETING_PATH.read_text().strip()
        if content:
            return content
    except (FileNotFoundError, PermissionError):
        pass
    return None


GREETING_GENERATION_PROMPT = (
    "Generate a short, punchy greeting for the next time this person calls. "
    "One sentence max. No quotes. No emojis. Just the raw greeting text."
)

OPENCLAW_URL = "http://localhost:18789/v1/chat/completions"


async def _generate_next_greeting(settings: Settings, session_key: str) -> None:
    """Ask OpenClaw to generate a greeting for the next call and write it to disk."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                OPENCLAW_URL,
                headers={
                    "Authorization": f"Bearer {settings.OPENCLAW_GATEWAY_TOKEN}",
                    "x-openclaw-session-key": session_key,
                },
                json={
                    "model": settings.AGENT_THINK_MODEL,
                    "messages": [{"role": "user", "content": GREETING_GENERATION_PROMPT}],
                    "stream": False,
                },
                timeout=15.0,
            )
            resp.raise_for_status()
            data = resp.json()
            greeting = data["choices"][0]["message"]["content"].strip()
            if greeting:
                NEXT_GREETING_PATH.write_text(greeting)
                logger.info("Next greeting saved: %s", greeting[:80])
    except Exception:
        logger.exception("Failed to generate next greeting")


def build_settings_config(
    settings: Settings,
    call_id: str,
    prompt_override: str | None = None,
    greeting_override: str | None = None,
) -> dict:
    """Build the Deepgram Agent Settings message.

    Parameters
    ----------
    prompt_override:
        When set, use this prompt instead of the default or USER.md-based
        prompt.  Used for outbound calls where the callee is not the user.
    greeting_override:
        When set, use this greeting instead of the default.
    """
    headers = {
        "Authorization": f"Bearer {settings.OPENCLAW_GATEWAY_TOKEN}",
        "x-openclaw-session-key": f"agent:{settings.OPENCLAW_AGENT_ID}:{call_id}",
    }

    fly_machine_id = os.environ.get("FLY_MACHINE_ID")
    if fly_machine_id:
        headers["fly-force-instance-id"] = fly_machine_id

    if prompt_override:
        prompt = prompt_override
        greeting = greeting_override or "Hello!"
        logger.info("Using prompt override (outbound call)")
    elif (user_context := _read_user_context()):
        prompt = f"{KNOWN_USER_PROMPT}\n\nHere is what you know about the caller:\n{user_context}"
        greeting = _read_next_greeting() or "Welcome back! How may I help today?"
        logger.info("Using known-user prompt (USER.md found)")
    else:
        prompt = settings.AGENT_PROMPT
        greeting = _read_next_greeting() or settings.AGENT_GREETING
        logger.info("Using new-caller prompt (no USER.md)")

    return {
        "type": "Settings",
        "audio": {
            "input": {"encoding": "mulaw", "sample_rate": 8000},
            "output": {"encoding": "mulaw", "sample_rate": 8000, "container": "none"},
        },
        "agent": {
            "listen": {
                "provider": {"type": "deepgram", "model": settings.AGENT_LISTEN_MODEL},
            },
            "think": {
                "provider": {
                    "type": "open_ai",
                    "model": settings.AGENT_THINK_MODEL,
                },
                "endpoint": {
                    "url": f"{settings.PUBLIC_URL}/v1/chat/completions",
                    "headers": headers,
                },
                "prompt": prompt,
            },
            "speak": {
                "provider": {"type": "deepgram", "model": settings.AGENT_VOICE},
            },
            "greeting": greeting,
        },
    }


async def _twilio_to_deepgram(
    twilio_ws: WebSocket,
    dg_ws,
    stop_event: asyncio.Event,
) -> None:
    """Forward audio from Twilio to Deepgram."""
    try:
        while not stop_event.is_set():
            try:
                raw = await asyncio.wait_for(twilio_ws.receive_text(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            event = parse_twilio_event(raw)
            if event is None:
                continue

            if event.get("event") == "media":
                audio = extract_audio_from_media_event(event)
                if audio:
                    await dg_ws.send(audio)
            elif event.get("event") == "stop":
                logger.info("Twilio sent stop event")
                stop_event.set()
                return
    except WebSocketDisconnect:
        logger.info("Twilio WS disconnected")
        stop_event.set()
    except ConnectionClosed:
        logger.info("Twilio WS connection closed")
        stop_event.set()
    except Exception:
        logger.exception("Error in twilio_to_deepgram")
        stop_event.set()


async def _deepgram_to_twilio(
    dg_ws,
    twilio_ws: WebSocket,
    stream_sid: str,
    stop_event: asyncio.Event,
) -> None:
    """Forward audio from Deepgram to Twilio and handle agent events."""
    try:
        async for message in dg_ws:
            if stop_event.is_set():
                return

            if isinstance(message, bytes):
                await twilio_ws.send_text(build_media_event(stream_sid, message))

            elif isinstance(message, str):
                try:
                    msg = json.loads(message)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type", "")

                if msg_type == "Error":
                    logger.error("Deepgram error: %s", json.dumps(msg))
                elif msg_type == "ConversationText":
                    role = msg.get("role", "")
                    content = msg.get("content", "")
                    logger.info("Conversation [%s]: %s", role, content)
                elif msg_type == "Warning":
                    logger.warning("Deepgram warning: %s", json.dumps(msg))
                else:
                    logger.info("Deepgram event: %s", msg_type)

                if msg_type == "UserStartedSpeaking":
                    await twilio_ws.send_text(build_clear_event(stream_sid))

    except ConnectionClosed:
        logger.info("Deepgram WS closed")
    except WebSocketDisconnect:
        logger.info("Twilio WS disconnected during dg->twilio")
        stop_event.set()
    except Exception:
        logger.exception("Error in deepgram_to_twilio")
        stop_event.set()


async def run_agent_bridge(
    twilio_ws: WebSocket,
    stream_sid: str,
    settings: Settings | None = None,
    call_id: str | None = None,
    prompt_override: str | None = None,
    greeting_override: str | None = None,
) -> None:
    """Run the Deepgram Voice Agent bridge.

    Connects to Deepgram, sends settings config, then relays audio
    bidirectionally between Twilio and Deepgram until disconnect.

    Parameters
    ----------
    call_id:
        Session identifier.  Generated automatically if not provided.
    prompt_override:
        Custom prompt for the agent (used for outbound calls).
    greeting_override:
        Custom greeting (used for outbound calls).
    """
    if settings is None:
        settings = get_settings()

    logger.info("Agent bridge starting, connecting to %s", settings.DEEPGRAM_AGENT_URL)

    try:
        dg_ws = await connect(
            settings.DEEPGRAM_AGENT_URL,
            additional_headers={"Authorization": f"Token {settings.DEEPGRAM_API_KEY}"},
        )
    except Exception:
        logger.exception("Failed to connect to Deepgram Agent")
        return

    try:
        if call_id is None:
            call_id = uuid.uuid4().hex[:12]
        config = build_settings_config(
            settings,
            call_id=call_id,
            prompt_override=prompt_override,
            greeting_override=greeting_override,
        )
        await dg_ws.send(json.dumps(config))
        logger.info("Sent settings config to Deepgram")

        stop_event = asyncio.Event()

        t2d = asyncio.create_task(_twilio_to_deepgram(twilio_ws, dg_ws, stop_event))
        d2t = asyncio.create_task(
            _deepgram_to_twilio(dg_ws, twilio_ws, stream_sid, stop_event)
        )

        await asyncio.gather(t2d, d2t, return_exceptions=True)

    finally:
        try:
            await dg_ws.close()
        except Exception:
            pass

        # Post-call: generate next greeting (inbound calls only)
        if not prompt_override:
            session_key = f"agent:{settings.OPENCLAW_AGENT_ID}:{call_id}"
            await _generate_next_greeting(settings, session_key=session_key)

    logger.info("Agent bridge finished")
