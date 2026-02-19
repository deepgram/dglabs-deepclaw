"""Tests for the VoiceStatusInjector."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.voice_status_injector import (
    COOLDOWN_SECONDS,
    INITIAL_HOLDOFF_SECONDS,
    VoiceStatusInjector,
    get_tool_phrase,
)
from app.services import session_registry


# ---------------------------------------------------------------------------
# get_tool_phrase tests
# ---------------------------------------------------------------------------


def test_exact_match():
    assert get_tool_phrase("web_search") == "Let me search for that."
    assert get_tool_phrase("read_file") == "Checking some results."
    assert get_tool_phrase("memory_search") == "Let me check my notes."
    assert get_tool_phrase("calendar_events") == "Checking your calendar."
    assert get_tool_phrase("sessions_spawn") == "Kicking off a background task."


def test_substring_match():
    assert get_tool_phrase("mcp__brave__web_search") == "Let me search for that."
    assert get_tool_phrase("mcp__local__read_file") == "Checking some results."


def test_unknown_tool_default():
    assert get_tool_phrase("totally_unknown_tool") == "Still working on that."
    assert get_tool_phrase("") == "Still working on that."


# ---------------------------------------------------------------------------
# VoiceStatusInjector lifecycle tests
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_gw():
    """Provide a mock gateway WS client."""
    gw = AsyncMock()
    gw.subscribe = AsyncMock()
    gw.unsubscribe = AsyncMock()
    with patch("app.services.voice_status_injector.get_gateway_ws", return_value=gw):
        yield gw


@pytest.fixture
def mock_dg_ws():
    """Provide a mock Deepgram WebSocket."""
    ws = AsyncMock()
    ws.send = AsyncMock()
    return ws


@pytest.fixture
def injector(mock_gw, mock_dg_ws):
    """Create and return a VoiceStatusInjector (not yet started)."""
    return VoiceStatusInjector("agent:main:test123", mock_dg_ws)


@pytest.mark.asyncio
async def test_start_subscribes(mock_gw, mock_dg_ws):
    inj = VoiceStatusInjector("agent:main:sub-test", mock_dg_ws)
    await inj.start()
    mock_gw.subscribe.assert_awaited_once_with("agent:main:sub-test", inj._on_event)


@pytest.mark.asyncio
async def test_stop_unsubscribes(mock_gw, mock_dg_ws):
    inj = VoiceStatusInjector("agent:main:unsub-test", mock_dg_ws)
    await inj.start()
    await inj.stop()
    mock_gw.unsubscribe.assert_awaited_once_with("agent:main:unsub-test")
    assert inj._stopped is True


@pytest.mark.asyncio
async def test_start_without_gateway(mock_dg_ws):
    """If no gateway WS client exists, start() should not raise."""
    with patch("app.services.voice_status_injector.get_gateway_ws", return_value=None):
        inj = VoiceStatusInjector("agent:main:no-gw", mock_dg_ws)
        await inj.start()  # Should not raise


# ---------------------------------------------------------------------------
# Event handling tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tool_start_injects(injector, mock_dg_ws):
    """Tool start event should schedule and fire an injection."""
    await injector.start()
    injector.reset()  # Sets _request_started_at

    # Simulate elapsed time so holdoff/cooldown are already past
    injector._request_started_at = 0.0
    injector._last_inject_time = 0.0

    # Fire tool start event
    injector._on_event("agent", {
        "sessionKey": "agent:main:test123",
        "state": "",
        "stream": "tool",
        "data": {"phase": "start", "name": "web_search"},
    })

    # Allow the call_later to fire (delay should be ~0 since times are in the past)
    await asyncio.sleep(0.05)

    mock_dg_ws.send.assert_awaited_once()
    sent = json.loads(mock_dg_ws.send.call_args[0][0])
    assert sent["type"] == "InjectAgentMessage"
    assert sent["message"] == "Let me search for that."


@pytest.mark.asyncio
async def test_chat_delta_stops(injector, mock_dg_ws):
    """chat.delta should cancel pending injections and suppress future ones."""
    await injector.start()
    injector.reset()
    injector._request_started_at = 0.0
    injector._last_inject_time = 0.0

    # Fire tool start (schedules injection)
    injector._on_event("agent", {
        "sessionKey": "agent:main:test123",
        "state": "",
        "stream": "tool",
        "data": {"phase": "start", "name": "web_search"},
    })

    # Immediately fire chat delta (cancels injection)
    injector._on_event("chat", {
        "sessionKey": "agent:main:test123",
        "state": "delta",
        "stream": "",
        "data": {},
    })

    assert injector._content_streaming is True
    assert injector._pending_inject is None

    await asyncio.sleep(0.05)
    mock_dg_ws.send.assert_not_awaited()


@pytest.mark.asyncio
async def test_muted_skips(injector, mock_dg_ws):
    """No injection when session is muted."""
    await injector.start()
    injector.reset()
    injector._request_started_at = 0.0
    injector._last_inject_time = 0.0

    # Register session and set muted
    session_registry.register("agent:main:test123", mock_dg_ws)
    session_registry.set_muted("agent:main:test123", True)

    try:
        injector._on_event("agent", {
            "sessionKey": "agent:main:test123",
            "state": "",
            "stream": "tool",
            "data": {"phase": "start", "name": "web_search"},
        })

        await asyncio.sleep(0.05)
        mock_dg_ws.send.assert_not_awaited()
    finally:
        session_registry.unregister("agent:main:test123")


@pytest.mark.asyncio
async def test_cooldown_delays(injector, mock_dg_ws):
    """Second tool within cooldown should not inject immediately."""
    await injector.start()
    injector.reset()
    injector._request_started_at = 0.0

    # Pretend we just injected
    import time
    injector._last_inject_time = time.monotonic()

    injector._on_event("agent", {
        "sessionKey": "agent:main:test123",
        "state": "",
        "stream": "tool",
        "data": {"phase": "start", "name": "read_file"},
    })

    # Should have a pending inject but NOT have fired yet (cooldown active)
    assert injector._pending_inject is not None
    mock_dg_ws.send.assert_not_awaited()

    # Cleanup
    injector._cancel_pending()


@pytest.mark.asyncio
async def test_reset_clears_streaming(injector, mock_dg_ws):
    """reset() should allow injections again after content streaming."""
    await injector.start()
    injector.reset()

    # Simulate content streaming
    injector._on_event("chat", {
        "sessionKey": "agent:main:test123",
        "state": "delta",
        "stream": "",
        "data": {},
    })
    assert injector._content_streaming is True

    # Reset for new turn
    injector.reset()
    assert injector._content_streaming is False


@pytest.mark.asyncio
async def test_stop_prevents_injection(injector, mock_dg_ws):
    """After stop(), events should be ignored."""
    await injector.start()
    injector.reset()
    injector._request_started_at = 0.0
    injector._last_inject_time = 0.0

    await injector.stop()

    injector._on_event("agent", {
        "sessionKey": "agent:main:test123",
        "state": "",
        "stream": "tool",
        "data": {"phase": "start", "name": "web_search"},
    })

    await asyncio.sleep(0.05)
    mock_dg_ws.send.assert_not_awaited()


@pytest.mark.asyncio
async def test_non_tool_events_ignored(injector, mock_dg_ws):
    """Events that aren't tool-start or chat-delta should be ignored."""
    await injector.start()
    injector.reset()
    injector._request_started_at = 0.0

    # Random agent event (not tool stream)
    injector._on_event("agent", {
        "sessionKey": "agent:main:test123",
        "state": "",
        "stream": "thinking",
        "data": {"phase": "start", "name": "something"},
    })

    await asyncio.sleep(0.05)
    mock_dg_ws.send.assert_not_awaited()
