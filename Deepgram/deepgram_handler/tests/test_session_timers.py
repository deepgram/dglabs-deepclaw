"""Tests for SessionTimers — response timeout and idle caller detection."""

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


@pytest.mark.asyncio
async def test_idle_prompt_fires_after_agent_audio_done():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(idle_prompt_ms=100, idle_exit_ms=100), cb)

    timers.on_agent_audio_done()
    await asyncio.sleep(0.15)  # > 100ms idle prompt

    cb.inject_message.assert_called_once_with("Still there?")
    cb.end_call.assert_not_called()

    timers.clear_all()


@pytest.mark.asyncio
async def test_idle_exit_fires_after_prompt():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(idle_prompt_ms=100, idle_exit_ms=100), cb)

    timers.on_agent_audio_done()
    await asyncio.sleep(0.55)  # > 100ms prompt + 100ms exit + post-exit delay

    assert cb.inject_message.call_count >= 2
    cb.end_call.assert_called_once()

    timers.clear_all()


@pytest.mark.asyncio
async def test_user_speech_resets_idle_timers():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(idle_prompt_ms=100, idle_exit_ms=100), cb)

    timers.on_agent_audio_done()
    await asyncio.sleep(0.05)  # < 100ms
    timers.on_user_spoke()     # Resets idle + starts response
    await asyncio.sleep(0.5)

    # Idle prompt should NOT have fired (was reset)
    # Response reengage might have fired instead
    for call in cb.inject_message.call_args_list:
        assert call[0][0] != "Still there?"

    timers.clear_all()


@pytest.mark.asyncio
async def test_idle_prompted_guard_prevents_reentrance():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(idle_prompt_ms=100, idle_exit_ms=500), cb)

    timers.on_agent_audio_done()
    await asyncio.sleep(0.15)  # Prompt fires

    # Simulate the prompt's own agentAudioDone
    timers.on_agent_audio_done()
    await asyncio.sleep(0.15)

    # Should only have one inject (the prompt), not a second prompt
    cb.inject_message.assert_called_once_with("Still there?")

    timers.clear_all()


@pytest.mark.asyncio
async def test_disabled_timers_do_nothing():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(enabled=False), cb)

    timers.on_user_spoke()
    timers.on_agent_audio_done()
    await asyncio.sleep(0.5)

    cb.inject_message.assert_not_called()
    cb.end_call.assert_not_called()


@pytest.mark.asyncio
async def test_clear_all_prevents_pending_callbacks():
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(), cb)

    timers.on_user_spoke()
    timers.clear_all()
    await asyncio.sleep(0.5)

    cb.inject_message.assert_not_called()
    cb.end_call.assert_not_called()


# ---------------------------------------------------------------------------
# Pause / Resume tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pause_prevents_timers_from_firing():
    """Paused timers should not fire even after their timeout elapses."""
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(response_reengage_ms=100), cb)

    timers.on_user_spoke()
    timers.pause()
    await asyncio.sleep(0.3)  # > 100ms reengage

    cb.inject_message.assert_not_called()
    cb.end_call.assert_not_called()

    timers.clear_all()


@pytest.mark.asyncio
async def test_pause_clears_running_timers():
    """Calling pause() should cancel any in-flight timers."""
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(response_reengage_ms=100), cb)

    timers.on_user_spoke()
    await asyncio.sleep(0.05)  # < 100ms
    timers.pause()
    await asyncio.sleep(0.2)  # > 100ms total

    cb.inject_message.assert_not_called()

    timers.clear_all()


@pytest.mark.asyncio
async def test_resume_re_enables_timers():
    """After resume(), on_* events should schedule timers again."""
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(response_reengage_ms=100), cb)

    timers.pause()
    timers.on_user_spoke()  # Should be ignored (paused)
    await asyncio.sleep(0.15)
    cb.inject_message.assert_not_called()

    timers.resume()
    timers.on_user_spoke()  # Should work now
    await asyncio.sleep(0.15)

    cb.inject_message.assert_called_once_with("Re-engage")

    timers.clear_all()


@pytest.mark.asyncio
async def test_pause_blocks_all_event_methods():
    """All on_* methods are no-ops while paused."""
    cb = _make_callbacks()
    timers = SessionTimers(
        _make_config(response_reengage_ms=50, idle_prompt_ms=50), cb
    )

    timers.pause()

    timers.on_user_spoke()
    timers.on_agent_started_speaking()
    timers.on_user_started_speaking()
    timers.on_agent_audio_done()

    await asyncio.sleep(0.2)

    cb.inject_message.assert_not_called()
    cb.end_call.assert_not_called()

    timers.clear_all()


# ---------------------------------------------------------------------------
# Agent speaking clears idle timers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_speaking_clears_idle_timers():
    """Agent starting to speak should cancel idle timers.

    Reproduces the bug where a filler phrase's AgentAudioDone starts the idle
    timer, the LLM is slow, and the idle prompt fires mid-response because
    on_agent_started_speaking only cleared response timers.
    """
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(idle_prompt_ms=100, idle_exit_ms=100), cb)

    # Filler finishes — starts idle timer
    timers.on_agent_audio_done()
    await asyncio.sleep(0.05)  # < 100ms — timer still pending

    # Real response starts — should clear idle timer
    timers.on_agent_started_speaking()
    await asyncio.sleep(0.2)  # > 100ms — would have fired if not cleared

    cb.inject_message.assert_not_called()
    cb.end_call.assert_not_called()

    timers.clear_all()


@pytest.mark.asyncio
async def test_agent_speaking_resets_idle_prompted_flag():
    """Agent starting to speak should reset the idle_prompted flag.

    If an idle prompt already fired, then the agent speaks (responding to the
    prompt), the flag should reset so a new idle cycle can start after the
    agent finishes.
    """
    cb = _make_callbacks()
    timers = SessionTimers(_make_config(idle_prompt_ms=50, idle_exit_ms=500), cb)

    # Idle prompt fires
    timers.on_agent_audio_done()
    await asyncio.sleep(0.1)  # > 50ms — prompt fires
    assert cb.inject_message.call_count == 1

    # Agent speaks (responding to prompt) — should reset idle_prompted
    timers.on_agent_started_speaking()

    # Agent finishes — should be able to start a new idle cycle
    cb.inject_message.reset_mock()
    timers.on_agent_audio_done()
    await asyncio.sleep(0.1)  # > 50ms — prompt should fire again

    cb.inject_message.assert_called_once_with("Still there?")

    timers.clear_all()
