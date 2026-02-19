"""Session timer management for voice calls.

Handles two failure modes:
1. Response timeout — LLM stalls after user speaks (dead air)
2. Idle caller — caller goes silent after agent finishes speaking

Uses asyncio timers and communicates through callbacks.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

# Delay between injecting exit/goodbye message and actually hanging up,
# giving TTS time to finish speaking.
POST_EXIT_DELAY_S = 3.0


@dataclass
class SessionTimerCallbacks:
    inject_message: Callable[[str], Awaitable[None]]
    end_call: Callable[[], Awaitable[None]]
    log: Callable[[str], Any]


class SessionTimers:
    """Manages response timeout and idle caller detection timers.

    All timing is done via asyncio tasks so they integrate naturally
    with the event loop running the Deepgram bridge.
    """

    def __init__(self, config: dict, callbacks: SessionTimerCallbacks) -> None:
        self._config = config
        self._cb = callbacks

        self._response_reengage_handle: asyncio.TimerHandle | None = None
        self._response_exit_handle: asyncio.TimerHandle | None = None
        self._idle_prompt_handle: asyncio.TimerHandle | None = None
        self._idle_exit_handle: asyncio.TimerHandle | None = None

        self._idle_prompted: bool = False
        self._exiting: bool = False
        self._paused: bool = False

    @property
    def enabled(self) -> bool:
        return self._config.get("enabled", True)

    # ------------------------------------------------------------------
    # Response timeout chain
    # ------------------------------------------------------------------

    def on_user_spoke(self) -> None:
        """User spoke — start response timers, clear idle timers."""
        if not self.enabled or self._exiting or self._paused:
            return

        self._clear_response_timers()
        self._clear_idle_timers()
        self._idle_prompted = False

        reengage_ms = self._config.get("response_reengage_ms", 0)
        exit_ms = self._config.get("response_exit_ms", 0)

        loop = asyncio.get_running_loop()

        if reengage_ms > 0:
            self._response_reengage_handle = loop.call_later(
                reengage_ms / 1000,
                lambda: asyncio.ensure_future(self._fire_response_reengage()),
            )

        if exit_ms > 0:
            self._response_exit_handle = loop.call_later(
                exit_ms / 1000,
                lambda: asyncio.ensure_future(self._fire_response_exit()),
            )

        self._cb.log(
            f"[SessionTimers] on_user_spoke — response timers started "
            f"(reengage={reengage_ms}ms, exit={exit_ms}ms)"
        )

    def on_agent_started_speaking(self) -> None:
        """Agent started speaking — cancel response and idle timers.

        Idle timers must also be cleared because the agent speaking means the
        session is active.  Without this, a long LLM delay between a filler
        phrase's AgentAudioDone and the real response's AgentStartedSpeaking
        can cause the idle timer to fire mid-response.
        """
        if not self.enabled or self._exiting or self._paused:
            return
        had_response = self._response_reengage_handle is not None or self._response_exit_handle is not None
        had_idle = self._idle_prompt_handle is not None or self._idle_exit_handle is not None
        self._clear_response_timers()
        self._clear_idle_timers()
        self._idle_prompted = False
        if had_response or had_idle:
            self._cb.log("[SessionTimers] on_agent_started_speaking — response/idle timers cancelled")

    # ------------------------------------------------------------------
    # Idle caller detection chain
    # ------------------------------------------------------------------

    def on_user_started_speaking(self) -> None:
        """User started speaking — cancel idle timers (barge-in)."""
        if not self.enabled or self._exiting or self._paused:
            return
        had_timers = self._idle_prompt_handle is not None or self._idle_exit_handle is not None
        self._clear_idle_timers()
        self._idle_prompted = False
        if had_timers:
            self._cb.log("[SessionTimers] on_user_started_speaking — idle timers cancelled")

    def on_agent_audio_done(self) -> None:
        """Agent finished speaking — start idle timers."""
        if not self.enabled or self._exiting or self._paused:
            return
        if self._idle_prompted:
            self._cb.log("[SessionTimers] on_agent_audio_done — skipped (idle_prompted guard)")
            return

        self._clear_idle_timers()

        prompt_ms = self._config.get("idle_prompt_ms", 0)
        if prompt_ms > 0:
            loop = asyncio.get_running_loop()
            self._idle_prompt_handle = loop.call_later(
                prompt_ms / 1000,
                lambda: asyncio.ensure_future(self._fire_idle_prompt()),
            )
            self._cb.log(
                f"[SessionTimers] on_agent_audio_done — idle timer started (prompt={prompt_ms}ms)"
            )

    # ------------------------------------------------------------------
    # Timer fire handlers
    # ------------------------------------------------------------------

    async def _fire_response_reengage(self) -> None:
        if self._exiting:
            return
        self._cb.log("[SessionTimers] Response re-engage timeout — injecting message")
        msg = self._config.get("response_reengage_message", "")
        if msg:
            await self._cb.inject_message(msg)

    async def _fire_response_exit(self) -> None:
        if self._exiting:
            return
        self._exiting = True
        self._clear_response_timers()
        self._clear_idle_timers()
        self._cb.log("[SessionTimers] Response exit timeout — injecting exit message")
        msg = self._config.get("response_exit_message", "")
        try:
            if msg:
                await self._cb.inject_message(msg)
        except Exception:
            self._cb.log("[SessionTimers] Failed to inject exit message, proceeding with hangup")
        await asyncio.sleep(self._config.get("post_exit_delay_s", POST_EXIT_DELAY_S))
        await self._cb.end_call()

    async def _fire_idle_prompt(self) -> None:
        if self._exiting:
            return
        self._idle_prompted = True
        self._cb.log("[SessionTimers] Idle prompt — injecting message")
        msg = self._config.get("idle_prompt_message", "")
        if msg:
            await self._cb.inject_message(msg)

        exit_ms = self._config.get("idle_exit_ms", 0)
        if exit_ms > 0:
            loop = asyncio.get_running_loop()
            self._idle_exit_handle = loop.call_later(
                exit_ms / 1000,
                lambda: asyncio.ensure_future(self._fire_idle_exit()),
            )

    async def _fire_idle_exit(self) -> None:
        if self._exiting:
            return
        self._exiting = True
        self._clear_idle_timers()
        self._clear_response_timers()
        self._cb.log("[SessionTimers] Idle exit timeout — injecting exit message")
        msg = self._config.get("idle_exit_message", "")
        try:
            if msg:
                await self._cb.inject_message(msg)
        except Exception:
            self._cb.log("[SessionTimers] Failed to inject idle exit message, proceeding with hangup")
        await asyncio.sleep(self._config.get("post_exit_delay_s", POST_EXIT_DELAY_S))
        await self._cb.end_call()

    # ------------------------------------------------------------------
    # Pause / Resume (used during mute)
    # ------------------------------------------------------------------

    def pause(self) -> None:
        """Pause all timers (used during mute)."""
        self._paused = True
        self._clear_response_timers()
        self._clear_idle_timers()
        self._cb.log("[SessionTimers] paused")

    def resume(self) -> None:
        """Resume timer capability (used on unmute)."""
        self._paused = False
        self._cb.log("[SessionTimers] resumed")

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def _clear_response_timers(self) -> None:
        if self._response_reengage_handle:
            self._response_reengage_handle.cancel()
            self._response_reengage_handle = None
        if self._response_exit_handle:
            self._response_exit_handle.cancel()
            self._response_exit_handle = None

    def _clear_idle_timers(self) -> None:
        if self._idle_prompt_handle:
            self._idle_prompt_handle.cancel()
            self._idle_prompt_handle = None
        if self._idle_exit_handle:
            self._idle_exit_handle.cancel()
            self._idle_exit_handle = None

    def clear_all(self) -> None:
        """Cancel all timers and prevent further actions."""
        self._exiting = True
        self._clear_response_timers()
        self._clear_idle_timers()
        self._cb.log("[SessionTimers] clear_all — all timers cancelled")
