"""Deepgram Voice Agent bridge.

Connects to Deepgram's agent WebSocket and relays audio bidirectionally
with a Twilio media stream WebSocket.
"""

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from app.config import Settings, get_settings
from app.services import session_registry
from app.services.agent_identity import extract_agent_identity
from app.services.call_summary import generate_call_summary
from app.services.twilio_media import (
    build_clear_event,
    build_media_event,
    extract_audio_from_media_event,
    parse_twilio_event,
)
from app.services.user_md_parser import (
    has_values,
    is_blank_identity,
    parse_calls_md,
    parse_user_markdown,
)
from app.services.session_timers import SessionTimers, SessionTimerCallbacks
from app.services.user_profile import extract_user_profile
from app.services.workspace import CallInfo, TranscriptEntry

logger = logging.getLogger(__name__)

WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace"
USER_MD_PATH = WORKSPACE_DIR / "USER.md"
IDENTITY_MD_PATH = WORKSPACE_DIR / "IDENTITY.md"
CALLS_MD_PATH = WORKSPACE_DIR / "test-voice-agent" / "CALLS.md"
NEXT_GREETING_PATH = WORKSPACE_DIR / "NEXT_GREETING.txt"


def _read_file(path: Path) -> str | None:
    """Read a text file if it exists and is non-empty."""
    try:
        content = path.read_text().strip()
        if content:
            return content
    except (FileNotFoundError, PermissionError):
        pass
    return None


def _read_user_context() -> str | None:
    """Read USER.md from the workspace directory if it exists."""
    return _read_file(USER_MD_PATH)


def _read_next_greeting() -> str | None:
    """Read the pre-generated greeting for the next call, if it exists."""
    return _read_file(NEXT_GREETING_PATH)


def _build_voice_prompt(settings: Settings) -> tuple[str, bool]:
    """Build a structured voice prompt from workspace files.

    Returns a tuple of (prompt_text, is_first_caller).
    """
    # Read workspace files
    user_md = _read_file(USER_MD_PATH)
    identity_md = _read_file(IDENTITY_MD_PATH)
    calls_md = _read_file(CALLS_MD_PATH)

    # Parse USER.md
    profile = parse_user_markdown(user_md) if user_md else None
    profile_filled = profile is not None and has_values(profile)

    # Detect first caller: no user data AND blank identity
    is_first = not profile_filled and is_blank_identity(identity_md or "")

    # Determine caller's timezone for date/time context
    tz_label = ""
    if profile and profile.timezone:
        tz_label = profile.timezone

    lines: list[str] = []

    # -- Voice constraints --
    lines.append("You are on a phone call. Voice constraints:")
    lines.append("- Keep responses brief (1-2 sentences max). No markdown, plain conversational sentences only.")
    lines.append("- Do not start with filler phrases like \"Let me check\" or \"One moment\" — jump straight into the answer.")
    lines.append("- If a request is ambiguous, ask a quick clarifying question before acting.")
    if tz_label:
        now = datetime.now(timezone.utc)
        lines.append(f"- The caller's timezone is {tz_label}. Current UTC time: {now.strftime('%Y-%m-%d %H:%M UTC')}.")
    else:
        now = datetime.now(timezone.utc)
        lines.append(f"- Current UTC time: {now.strftime('%Y-%m-%d %H:%M UTC')}.")
    lines.append("- If you are asked to text or call someone, use the twilio action.")
    lines.append("")
    lines.append("Background tasks:")
    lines.append(
        "- For anything that takes more than a few seconds (research, writing, analysis, "
        "lookups, multi-step tasks), use sessions_spawn to run it in the background."
    )
    lines.append(
        "- Tell the caller you'll text them the results. Example: "
        "\"I'll research that and text you what I find.\""
    )
    lines.append("- Do NOT make the caller wait on the phone while you do long tool calls or web searches.")
    lines.append("- Quick factual answers (weather, time, simple math) can be answered directly.")

    # -- Caller context (returning caller) --
    if profile_filled:
        lines.append("")
        lines.append("Caller context:")
        if profile.call_name or profile.name:
            display_name = profile.call_name or profile.name
            lines.append(f"- Caller's name: {display_name}. Greet them by name.")
        if profile.pronouns:
            lines.append(f"- Pronouns: {profile.pronouns}")
        if profile.notes:
            lines.append(f"- About them: {profile.notes}")
        if profile.context:
            lines.append(f"- Context: {profile.context}")

        # Recent calls from CALLS.md
        if calls_md:
            recent = parse_calls_md(calls_md, count=3)
            if recent:
                lines.append("")
                lines.append("Recent calls:")
                for entry in recent:
                    # Indent each line of the entry
                    for sub_line in entry.split("\n"):
                        lines.append(f"  {sub_line}")

    # -- Action nudges --
    if settings.ENABLE_ACTION_NUDGES:
        lines.append("")
        if profile_filled and not is_first:
            window = settings.RETURNING_CALLER_NUDGE_WINDOW_SEC
            lines.append(
                f"Nudge: This is a returning caller. Reference a recent interaction if possible. "
                f"Steer the conversation toward a concrete action within {window} seconds."
            )
        elif is_first:
            window = settings.FIRST_CALLER_NUDGE_WINDOW_SEC
            lines.append(
                f"Nudge: This is a first-time caller. Offer to DO something useful for them "
                f"within {window} seconds. Show value quickly."
            )

    # -- First-caller bootstrap --
    if is_first:
        lines.append("")
        lines.append("First-caller bootstrap:")
        lines.append("- You don't have a name yet. If the caller asks, say you haven't picked one yet.")
        lines.append("- Within the first exchange, naturally ask their name.")
        lines.append(
            "- IMPORTANT: When someone says 'call me [name]', they are telling you their NAME "
            "— not asking you to make a phone call."
        )
        lines.append("- Goal: names exchanged, something useful done, give them a reason to call back.")

    # Debug: summarize which sections were included
    sections = ["voice_constraints"]
    if profile_filled:
        display_name = profile.call_name or profile.name or "unnamed"
        sections.append(f"caller_context ({display_name})")
        if calls_md:
            recent = parse_calls_md(calls_md, count=3)
            if recent:
                sections.append(f"recent_calls ({len(recent)})")
    if settings.ENABLE_ACTION_NUDGES:
        if profile_filled and not is_first:
            sections.append("returning_nudge")
        elif is_first:
            sections.append("first_caller_nudge")
    if is_first:
        sections.append("bootstrap")
    logger.info("Prompt sections: %s", ", ".join(sections))

    return "\n".join(lines), is_first


GREETING_MODEL = "claude-haiku-4-5-20251001"
GREETING_TIMEOUT_S = 5.0


def _build_greeting_prompt(
    transcript: list | None = None,
    caller_name: str | None = None,
) -> str:
    """Build a contextual greeting generation prompt."""
    parts = []
    if caller_name:
        parts.append(f"The caller's name is {caller_name}.")
    if transcript:
        # Include last few exchanges for context
        recent = transcript[-6:] if len(transcript) > 6 else transcript
        lines = []
        for entry in recent:
            speaker = "Caller" if entry.speaker == "user" else "You"
            lines.append(f"  {speaker}: {entry.text}")
        parts.append("Recent conversation:\n" + "\n".join(lines))

    context = " ".join(parts) if parts else "You don't know much about this caller yet."

    return (
        f"{context}\n\n"
        "Generate a short, punchy greeting for the next time this person calls. "
        "Reference something specific from the conversation if possible. "
        "One sentence max. No quotes. No emojis. Just the raw greeting text."
    )


async def _generate_next_greeting(
    settings: Settings,
    session_key: str,
    transcript: list | None = None,
    caller_name: str | None = None,
) -> None:
    """Generate a greeting for the next call via direct Anthropic API.

    Calls Anthropic directly (bypassing the local gateway) so the request
    doesn't get queued behind long-running tool calls.
    """
    api_key = settings.ANTHROPIC_API_KEY
    if not api_key:
        logger.warning("Next greeting: no ANTHROPIC_API_KEY, skipping")
        return

    prompt = _build_greeting_prompt(transcript, caller_name)
    logger.info("Next greeting prompt: %s", prompt[:200])

    url = f"{settings.ANTHROPIC_BASE_URL.rstrip('/')}/v1/messages"
    try:
        async with asyncio.timeout(GREETING_TIMEOUT_S):
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    url,
                    headers={
                        "Content-Type": "application/json",
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                    },
                    json={
                        "model": GREETING_MODEL,
                        "max_tokens": 100,
                        "messages": [
                            {"role": "user", "content": prompt}
                        ],
                    },
                    timeout=GREETING_TIMEOUT_S,
                )
                if resp.status_code != 200:
                    logger.warning("Next greeting: Anthropic returned %d: %s", resp.status_code, resp.text[:200])
                    return

                data = resp.json()
                content_blocks = data.get("content", [])
                greeting = ""
                for block in content_blocks:
                    if block.get("type") == "text":
                        greeting = block.get("text", "").strip()
                        break

                if greeting:
                    NEXT_GREETING_PATH.write_text(greeting)
                    logger.info("Next greeting saved: %s", greeting[:80])
                else:
                    logger.warning("Next greeting: empty response from Anthropic")
    except (asyncio.TimeoutError, TimeoutError):
        logger.warning("Next greeting: timed out after %.1fs", GREETING_TIMEOUT_S)
    except Exception:
        logger.exception("Failed to generate next greeting")


async def _notify_child_sessions(
    settings: Settings,
    session_key: str,
    caller_number: str | None = None,
) -> None:
    """Notify child sessions that the voice call has ended.

    Queries the gateway for sessions spawned by this voice call and sends
    each one a message instructing it to deliver results via SMS instead.
    """
    from app.services.gateway import call_gateway

    try:
        logger.info("Querying child sessions for %s", session_key)
        result = await call_gateway(
            method="sessions.list",
            params={
                "spawnedBy": session_key,
                "limit": 50,
                "includeGlobal": False,
                "includeUnknown": False,
            },
            gateway_url="ws://localhost:18789",
            gateway_token=settings.OPENCLAW_GATEWAY_TOKEN,
            timeout=5.0,
        )

        if not result:
            logger.info("No child sessions result (gateway returned None)")
            return

        sessions = result.get("sessions", [])
        if not sessions:
            logger.info("No child sessions found for %s", session_key)
            return

        logger.info("Notifying %d child session(s) that call ended", len(sessions))

        for session in sessions:
            child_key = session.get("key", "")
            if not child_key:
                continue

            if caller_number:
                message = (
                    f"The voice call has ended — the caller is no longer on the phone. "
                    f'Send your results via SMS instead: use the twilio action with target "{caller_number}".'
                )
            else:
                message = (
                    "The voice call has ended — the caller is no longer on the phone. "
                    "If you have results to deliver, send them via SMS using the twilio action."
                )

            logger.info("Notifying child session %s", child_key)
            await call_gateway(
                method="agent",
                params={
                    "message": message,
                    "sessionKey": child_key,
                },
                gateway_url="ws://localhost:18789",
                gateway_token=settings.OPENCLAW_GATEWAY_TOKEN,
                timeout=10.0,
            )

    except Exception:
        logger.exception("Failed to notify child sessions")


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
    else:
        prompt, is_first = _build_voice_prompt(settings)
        if not is_first:
            # Returning caller — use parsed name for fallback greeting
            user_md = _read_file(USER_MD_PATH)
            profile = parse_user_markdown(user_md) if user_md else None
            display_name = None
            if profile:
                display_name = profile.call_name or profile.name or None
            if display_name:
                fallback = f"Hey {display_name}!"
            else:
                fallback = settings.AGENT_GREETING
            greeting = _read_next_greeting() or fallback
            logger.info("Using known-user prompt (returning caller)")
        else:
            greeting = _read_next_greeting() or settings.AGENT_GREETING
            logger.info("Using first-caller prompt (bootstrap)")

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
                "functions": [
                    {
                        "name": "end_call",
                        "description": (
                            "End the phone call gracefully. Use when the conversation "
                            "has concluded or the caller says goodbye."
                        ),
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "farewell": {
                                    "type": "string",
                                    "description": "Goodbye message to speak before hanging up",
                                },
                            },
                            "required": ["farewell"],
                        },
                    },
                ],
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
    transcript: list[TranscriptEntry] | None = None,
    timers: SessionTimers | None = None,
) -> None:
    """Forward audio from Deepgram to Twilio and handle agent events."""
    end_call_farewell_pending = False

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
                    if transcript is not None and content:
                        speaker = "user" if role == "user" else "bot"
                        transcript.append(
                            TranscriptEntry(timestamp=time.time(), speaker=speaker, text=content)
                        )
                    if timers:
                        if role == "user":
                            timers.on_user_spoke()
                        elif role == "assistant":
                            timers.on_agent_started_speaking()

                elif msg_type == "UserStartedSpeaking":
                    await twilio_ws.send_text(build_clear_event(stream_sid))
                    if timers:
                        timers.on_user_started_speaking()

                elif msg_type == "AgentStartedSpeaking":
                    if timers:
                        timers.on_agent_started_speaking()

                elif msg_type == "AgentAudioDone":
                    if timers:
                        timers.on_agent_audio_done()
                    if end_call_farewell_pending:
                        end_call_farewell_pending = False
                        logger.info("end_call farewell spoken, hanging up in 1s")
                        await asyncio.sleep(1.0)
                        stop_event.set()
                        return

                elif msg_type == "FunctionCallRequest":
                    fn_name = msg.get("function_name", "")
                    fn_call_id = msg.get("function_call_id", "")
                    fn_input = msg.get("input", {})

                    if fn_name == "end_call":
                        logger.info("end_call function invoked by LLM")
                        if timers:
                            timers.clear_all()
                        # ACK the function call
                        await dg_ws.send(json.dumps({
                            "type": "FunctionCallResponse",
                            "function_call_id": fn_call_id,
                            "output": json.dumps({"ok": True}),
                        }))
                        # Inject farewell
                        farewell = fn_input.get("farewell", "Goodbye!")
                        await dg_ws.send(json.dumps({
                            "type": "InjectAgentMessage",
                            "message": farewell,
                        }))
                        end_call_farewell_pending = True
                    else:
                        logger.info("Unhandled function call: %s", fn_name)

                elif msg_type == "Warning":
                    logger.warning("Deepgram warning: %s", json.dumps(msg))
                else:
                    logger.info("Deepgram event: %s", msg_type)

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
    caller_phone: str | None = None,
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
    caller_phone:
        Caller's phone number (E.164 format) for post-call extraction.
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

    session_key = None
    timers: SessionTimers | None = None
    try:
        if call_id is None:
            call_id = uuid.uuid4().hex[:12]

        session_key = f"agent:{settings.OPENCLAW_AGENT_ID}:{call_id}"

        config = build_settings_config(
            settings,
            call_id=call_id,
            prompt_override=prompt_override,
            greeting_override=greeting_override,
        )
        await dg_ws.send(json.dumps(config))
        logger.info("Sent settings config to Deepgram")

        session_registry.register(session_key, dg_ws)

        stop_event = asyncio.Event()
        transcript: list[TranscriptEntry] = []

        # Create session timers
        if settings.SESSION_TIMER_ENABLED:
            logger.info(
                "Session timers enabled (reengage=%dms, exit=%dms, idle_prompt=%dms, idle_exit=%dms)",
                settings.RESPONSE_REENGAGE_MS,
                settings.RESPONSE_EXIT_MS,
                settings.IDLE_PROMPT_MS,
                settings.IDLE_EXIT_MS,
            )
            timers = SessionTimers(
                {
                    "enabled": True,
                    "response_reengage_ms": settings.RESPONSE_REENGAGE_MS,
                    "response_exit_ms": settings.RESPONSE_EXIT_MS,
                    "idle_prompt_ms": settings.IDLE_PROMPT_MS,
                    "idle_exit_ms": settings.IDLE_EXIT_MS,
                    "response_reengage_message": settings.RESPONSE_REENGAGE_MESSAGE,
                    "response_exit_message": settings.RESPONSE_EXIT_MESSAGE,
                    "idle_prompt_message": settings.IDLE_PROMPT_MESSAGE,
                    "idle_exit_message": settings.IDLE_EXIT_MESSAGE,
                },
                SessionTimerCallbacks(
                    inject_message=lambda msg: dg_ws.send(
                        json.dumps({"type": "InjectAgentMessage", "message": msg})
                    ),
                    end_call=lambda: (stop_event.set(), asyncio.sleep(0))[1],
                    log=lambda msg: logger.info(msg),
                ),
            )

        t2d = asyncio.create_task(_twilio_to_deepgram(twilio_ws, dg_ws, stop_event))
        d2t = asyncio.create_task(
            _deepgram_to_twilio(dg_ws, twilio_ws, stream_sid, stop_event, transcript, timers)
        )

        await asyncio.gather(t2d, d2t, return_exceptions=True)

    finally:
        if timers:
            timers.clear_all()
            logger.info("Session timers cleared on bridge teardown")

        if session_key:
            session_registry.unregister(session_key)

        try:
            await dg_ws.close()
        except Exception:
            pass

        # Post-call tasks (inbound calls only)
        if not prompt_override:
            if not session_key:
                session_key = f"agent:{settings.OPENCLAW_AGENT_ID}:{call_id}"

            # Resolve caller name for greeting context
            user_md = _read_file(USER_MD_PATH)
            profile = parse_user_markdown(user_md) if user_md else None
            caller_name = None
            if profile:
                caller_name = profile.call_name or profile.name or None

            # Greeting generation with conversation context
            await _generate_next_greeting(
                settings,
                session_key=session_key,
                transcript=transcript,
                caller_name=caller_name,
            )

            # Notify child sessions that the call ended (fire-and-forget)
            if session_key:
                try:
                    await _notify_child_sessions(settings, session_key, caller_phone)
                except Exception:
                    logger.debug("Child session notification failed", exc_info=True)

            # Post-call extraction pipeline
            if transcript and settings.POST_CALL_EXTRACTION:
                call_info = CallInfo(
                    call_id=call_id,
                    phone_number=caller_phone or "unknown",
                    direction="inbound",
                    ended_at=time.time(),
                    transcript=transcript,
                )
                results = await asyncio.gather(
                    generate_call_summary(settings, call_info),
                    extract_user_profile(settings, call_info),
                    extract_agent_identity(settings, call_info),
                    return_exceptions=True,
                )
                for i, result in enumerate(results):
                    if isinstance(result, Exception):
                        task_names = ["call_summary", "user_profile", "agent_identity"]
                        logger.error("[post-call] %s failed: %s", task_names[i], result)

    logger.info("Agent bridge finished")
