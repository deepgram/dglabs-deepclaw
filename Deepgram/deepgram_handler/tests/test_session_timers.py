"""Tests for SessionTimers — response timeout chain."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.session_timers import SessionTimers, SessionTimerCallbacks


def _make_callbacks() -> SessionTimerCallbacks:
    return SessionTimerCallbacks(
        inject_message=AsyncMock(),
        end_call=AsyncMock(),
        log=MagicMock(),
    )


def _make_config(**overrides) -> dict:
    defaults = {
        "enabled": True,
        "response_reengage_ms": 150,   # Short for tests
        "response_exit_ms": 450,
        "idle_prompt_ms": 300,
        "idle_exit_ms": 150,
        "post_exit_delay_s": 0.1,      # Short for tests (production default: 3.0)
        "response_reengage_message": "Re-engage",
        "response_exit_message": "Goodbye",
        "idle_prompt_message": "Still there?",
        "idle_exit_message": "Bye idle",
    }
    defaults.update(overrides)
    return defaults


@pytest.mark.asyncio
async def test_response_reengage_fires_after_timeout():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(), cb)

    timers.on_user_spoke()
    await asyncio.sleep(0.2)  # > 150ms reengage

    cb.inject_message.assert_called_once_with("Re-engage")
    cb.end_call.assert_not_called()

    timers.clear_all()


@pytest.mark.asyncio
async def test_response_exit_fires_and_hangs_up():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(response_reengage_ms=100, response_exit_ms=200), cb)

    timers.on_user_spoke()
    await asyncio.sleep(0.55)  # > 200ms exit + 3s scaled -> use 300ms post-exit delay in tests

    # Should have injected both reengage and exit messages
    assert cb.inject_message.call_count >= 2
    cb.end_call.assert_called_once()

    timers.clear_all()


@pytest.mark.asyncio
async def test_agent_speaking_cancels_response_timers():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(), cb)

    timers.on_user_spoke()
    await asyncio.sleep(0.05)  # < 150ms reengage
    timers.on_agent_started_speaking()
    await asyncio.sleep(0.5)  # Wait past both thresholds

    cb.inject_message.assert_not_called()
    cb.end_call.assert_not_called()

    timers.clear_all()


@pytest.mark.asyncio
async def test_user_re_speaks_restarts_response_timers():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(), cb)

    timers.on_user_spoke()
    await asyncio.sleep(0.1)  # < 150ms
    timers.on_user_spoke()    # Restart
    await asyncio.sleep(0.1)  # Still < 150ms from restart

    cb.inject_message.assert_not_called()

    timers.clear_all()
