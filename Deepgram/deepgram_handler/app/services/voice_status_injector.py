"""Voice status injector — speaks tool-progress phrases during extended silence.

Subscribes to gateway WebSocket events for a voice session, maps tool-start
events to natural spoken phrases, and injects them via Deepgram's
``InjectAgentMessage`` protocol with cooldown and holdoff logic to avoid
colliding with the existing Haiku filler system.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from app.services.gateway_ws import get_gateway_ws
from app.services import session_registry

logger = logging.getLogger(__name__)

# -- constants ----------------------------------------------------------------

COOLDOWN_SECONDS: float = 7.0
"""Minimum seconds between injections."""

INITIAL_HOLDOFF_SECONDS: float = 3.5
"""Don't inject before this many seconds into a request (let filler fire first)."""

# -- tool → phrase mapping ----------------------------------------------------

TOOL_PHRASES: dict[str, str] = {
    "web_search": "Let me search for that.",
    "read_file": "Checking some results.",
    "memory_search": "Let me check my notes.",
    "calendar_events": "Checking your calendar.",
    "sessions_spawn": "Kicking off a background task.",
    "send_sms": "Sending a text message.",
    "make_call": "Making a call.",
}

_DEFAULT_PHRASE = "Still working on that."


def get_tool_phrase(tool_name: str) -> str:
    """Look up a spoken phrase for *tool_name*.

    Uses exact match first, then substring match (handles namespaced tools
    like ``mcp__brave__web_search``), then falls back to a generic default.
    """
    # Exact match
    if tool_name in TOOL_PHRASES:
        return TOOL_PHRASES[tool_name]

    # Substring match (e.g. "mcp__brave__web_search" contains "web_search")
    for key, phrase in TOOL_PHRASES.items():
        if key in tool_name:
            return phrase

    return _DEFAULT_PHRASE


# -- injector class -----------------------------------------------------------


class VoiceStatusInjector:
    """Injects tool-status phrases into a Deepgram voice session."""

    def __init__(self, session_key: str, dg_ws: Any) -> None:
        self.session_key = session_key
        self._dg_ws = dg_ws
        self._last_inject_time: float = 0.0
        self._request_started_at: float = 0.0
        self._content_streaming: bool = False
        self._stopped: bool = False
        self._pending_inject: asyncio.TimerHandle | None = None

    async def start(self) -> None:
        """Subscribe to gateway WS events for this session."""
        gw = get_gateway_ws()
        if not gw:
            logger.warning("[voice-status] no gateway WS client — injector disabled")
            return
        await gw.subscribe(self.session_key, self._on_event)
        logger.info("[voice-status] started for %s", self.session_key[-12:])

    async def stop(self) -> None:
        """Unsubscribe and cancel any pending injection."""
        self._stopped = True
        self._cancel_pending()
        gw = get_gateway_ws()
        if gw:
            await gw.unsubscribe(self.session_key)
        logger.info("[voice-status] stopped for %s", self.session_key[-12:])

    def reset(self) -> None:
        """Reset for a new user turn (called by proxy on each request)."""
        self._content_streaming = False
        self._request_started_at = time.monotonic()
        self._cancel_pending()
        logger.debug("[voice-status] reset for %s", self.session_key[-12:])

    # -- internal -------------------------------------------------------------

    def _on_event(self, event_name: str, payload: dict[str, Any]) -> None:
        """Gateway WS callback — route tool-start and chat.delta events."""
        if self._stopped:
            return

        state = payload.get("state", "")
        stream = payload.get("stream", "")
        data = payload.get("data", {})
        if not isinstance(data, dict):
            return

        phase = data.get("phase", "")
        name = data.get("name", "")

        # Tool start → schedule injection
        if event_name == "agent" and stream == "tool" and phase == "start" and name:
            logger.info("[voice-status] tool start: %s", name)
            self._schedule_inject(name)
            return

        # Chat delta → agent is responding, stop injecting
        if event_name == "chat" and state == "delta":
            if not self._content_streaming:
                logger.info("[voice-status] content streaming started — suppressing injections")
                self._content_streaming = True
                self._cancel_pending()

    def _schedule_inject(self, tool_name: str) -> None:
        """Schedule an injection after holdoff/cooldown, whichever is longer."""
        if self._content_streaming or self._stopped:
            return

        now = time.monotonic()

        # How long until holdoff expires
        holdoff_remaining = max(0.0, (self._request_started_at + INITIAL_HOLDOFF_SECONDS) - now)

        # How long until cooldown expires
        cooldown_remaining = max(0.0, (self._last_inject_time + COOLDOWN_SECONDS) - now)

        delay = max(holdoff_remaining, cooldown_remaining)
        phrase = get_tool_phrase(tool_name)

        logger.info(
            "[voice-status] scheduling '%s' in %.1fs (holdoff=%.1f cooldown=%.1f)",
            phrase, delay, holdoff_remaining, cooldown_remaining,
        )

        # Cancel any existing pending injection (latest tool wins)
        self._cancel_pending()

        loop = asyncio.get_event_loop()
        self._pending_inject = loop.call_later(delay, self._do_inject, phrase)

    def _do_inject(self, phrase: str) -> None:
        """Actually send the InjectAgentMessage (runs from call_later)."""
        self._pending_inject = None

        if self._stopped or self._content_streaming:
            return

        # Skip if session is muted
        if session_registry.is_muted(self.session_key):
            logger.info("[voice-status] skipping injection — session muted")
            return

        self._last_inject_time = time.monotonic()
        logger.info("[voice-status] injecting: '%s'", phrase)

        try:
            asyncio.ensure_future(
                self._dg_ws.send(
                    json.dumps({"type": "InjectAgentMessage", "message": phrase})
                )
            )
        except Exception:
            logger.warning("[voice-status] injection failed", exc_info=True)

    def _cancel_pending(self) -> None:
        """Cancel a scheduled-but-not-yet-fired injection."""
        if self._pending_inject is not None:
            self._pending_inject.cancel()
            self._pending_inject = None
