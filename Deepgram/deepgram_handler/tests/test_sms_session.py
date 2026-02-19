"""Tests for SMS session-level delivery coordination."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.services.sms_session import (
    _SMSSession,
    _extract_chat_text,
    _sessions,
    get_or_create_session,
    notify_agent_sms,
)


@pytest.fixture(autouse=True)
def _clear_sessions():
    """Ensure session registry is clean for each test."""
    yield
    _sessions.clear()


# -- Registry -----------------------------------------------------------------

def test_get_or_create_returns_same_object():
    s1 = get_or_create_session("key-a", "+1111", "+2222")
    s2 = get_or_create_session("key-a", "+1111", "+2222")
    assert s1 is s2


def test_get_or_create_different_keys():
    s1 = get_or_create_session("key-a", "+1111", "+2222")
    s2 = get_or_create_session("key-b", "+1111", "+2222")
    assert s1 is not s2


# -- reset_for_new_request ----------------------------------------------------

def test_reset_clears_delivery_flags():
    session = get_or_create_session("key-r", "+1111", "+2222")
    session.final_delivered = True
    session.twiml_replied = True
    session.reset_for_new_request()
    assert session.final_delivered is False
    assert session.twiml_replied is False


# -- Safety task cancellation -------------------------------------------------

@pytest.mark.asyncio
async def test_safety_task_cancelled_on_new_start():
    """When start_safety_task is called again, the old task is cancelled."""
    session = _SMSSession("key-s", "+1111", "+2222")

    # First safety task — a long-running coroutine
    fut1 = asyncio.get_event_loop().create_future()
    task1 = asyncio.create_task(_hang(fut1))
    session._safety_task = task1

    # Second call should cancel task1
    fut2 = asyncio.get_event_loop().create_future()
    task2 = asyncio.create_task(_hang(fut2))

    with patch("app.services.sms_session.send_sms", new_callable=AsyncMock):
        session.start_safety_task(task2)

    # Let the event loop process the cancellation
    await asyncio.sleep(0)
    assert task1.cancelled()
    # Clean up
    session._cancel_safety_task()


async def _hang(fut: asyncio.Future) -> str:
    """Coroutine that hangs until the future is resolved."""
    return await fut


# -- final_delivered prevents duplicate safety delivery -----------------------

@pytest.mark.asyncio
async def test_final_delivered_prevents_duplicate_safety():
    """If final_delivered is True, _safety_delayed skips delivery."""
    session = _SMSSession("key-f", "+1111", "+2222")
    session.final_delivered = True

    http_fut: asyncio.Future[str] = asyncio.get_event_loop().create_future()
    http_fut.set_result("Hello")

    mock_send = AsyncMock()
    with patch("app.services.sms_session.send_sms", mock_send), \
         patch("app.services.gateway_ws.get_gateway_ws", return_value=None):
        await session._safety_delayed(asyncio.ensure_future(http_fut))

    mock_send.assert_not_called()


# -- Agent delivery suppresses safety-delayed ----------------------------------

@pytest.mark.asyncio
async def test_agent_delivered_suppresses_safety_delayed():
    """If agent sent SMS directly, safety-delayed should skip."""
    session = get_or_create_session("key-ad", "+1111", "+2222")
    session._response_segments = ["Kicked off. I'll text you the link."]

    # Simulate agent sending SMS directly
    notify_agent_sms("+1111")
    assert session._agent_delivered is True

    http_fut: asyncio.Future[str] = asyncio.get_event_loop().create_future()
    http_fut.set_result("Kicked off. I'll text you the link.")

    mock_send = AsyncMock()
    with patch("app.services.sms_session.send_sms", mock_send), \
         patch("app.services.gateway_ws.get_gateway_ws", return_value=None):
        await session._safety_delayed(asyncio.ensure_future(http_fut))

    mock_send.assert_not_called()


def test_notify_agent_sms_only_matches_phone():
    """notify_agent_sms should not mark sessions for different numbers."""
    session = get_or_create_session("key-nm", "+1111", "+2222")
    notify_agent_sms("+9999")
    assert session._agent_delivered is False


# -- Silence intermediate trims to sentence boundary --------------------------

@pytest.mark.asyncio
async def test_silence_intermediate_trims_to_sentence():
    """Text like 'Hello world. Working on' should trim to 'Hello world.'"""
    session = _SMSSession("key-t", "+1111", "+2222")
    session.last_delta_text = "Hello world. Working on"

    mock_send = AsyncMock()
    with patch("app.services.sms_session.send_sms", mock_send), \
         patch("app.services.sms_session.check_general_rate_limit", return_value=(True, 0.0)):
        await session._send_silence_intermediate()

    mock_send.assert_called_once()
    sent_text = mock_send.call_args[1]["text"]
    assert sent_text == "Hello world."


@pytest.mark.asyncio
async def test_silence_intermediate_skips_when_final_delivered():
    """No send if final_delivered is True."""
    session = _SMSSession("key-skip", "+1111", "+2222")
    session.last_delta_text = "Hello world. Some text here."
    session.final_delivered = True

    mock_send = AsyncMock()
    with patch("app.services.sms_session.send_sms", mock_send):
        await session._send_silence_intermediate()

    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_silence_intermediate_skips_when_twiml_replied():
    """No send if twiml_replied is True."""
    session = _SMSSession("key-skip2", "+1111", "+2222")
    session.last_delta_text = "Hello world. Some text here."
    session.twiml_replied = True

    mock_send = AsyncMock()
    with patch("app.services.sms_session.send_sms", mock_send):
        await session._send_silence_intermediate()

    mock_send.assert_not_called()


# -- on_gateway_event ---------------------------------------------------------

@pytest.mark.asyncio
async def test_on_gateway_event_delta_sets_text():
    """chat.delta event updates last_delta_text."""
    session = _SMSSession("key-d", "+1111", "+2222")
    payload = {
        "state": "delta",
        "message": {"content": [{"type": "text", "text": "Thinking about it..."}]},
    }
    # Suppress the silence timer to avoid leaked handles
    with patch.object(session, "_cancel_silence"):
        await session.on_gateway_event("chat", payload)

    assert session.last_delta_text == "Thinking about it..."


# -- Safety-delayed sends segments individually --------------------------------

@pytest.mark.asyncio
async def test_safety_delayed_sends_segments_individually():
    """With WS segments captured, each unsent segment becomes its own SMS."""
    session = _SMSSession("key-seg", "+1111", "+2222")
    session._response_segments = [
        "Now let me read the Twitter skill and kick off a search.",
        "Good — the Reddit topics were AI automation and OpenClaw. Let me run a few searches.",
        "The raw JSON is huge. Let me parse it properly.",
        "Twitter skill works great. Here's what I found in detail.",
    ]
    session._sent_texts = [
        "Good — the Reddit topics were AI automation and OpenClaw.",
        "The raw JSON is huge. Let me parse it properly.",
    ]

    http_fut: asyncio.Future[str] = asyncio.get_event_loop().create_future()
    http_fut.set_result("ignored when segments exist")

    mock_send = AsyncMock()
    with patch("app.services.sms_session.send_sms", mock_send), \
         patch("app.services.gateway_ws.get_gateway_ws", return_value=None):
        await session._safety_delayed(asyncio.ensure_future(http_fut))

    # Segment 1: not sent before → sent in full
    # Segment 2: starts with sent intermediate → remainder "Let me run a few searches." sent
    # Segment 3: exact match with sent intermediate → skipped
    # Segment 4: not sent before → sent in full
    assert mock_send.call_count == 3
    texts = [call[1]["text"] for call in mock_send.call_args_list]
    assert texts[0] == "Now let me read the Twitter skill and kick off a search."
    assert texts[1] == "Let me run a few searches."
    assert texts[2] == "Twitter skill works great. Here's what I found in detail."


@pytest.mark.asyncio
async def test_safety_delayed_falls_back_to_full_reply():
    """Without WS segments, falls back to stripping from the full reply."""
    session = _SMSSession("key-fb", "+1111", "+2222")
    # No _response_segments — WS was down
    session._sent_texts = [
        "Good — the Reddit topics were AI automation and OpenClaw.",
    ]

    full_reply = (
        "Now let me read the Twitter skill."
        "Good — the Reddit topics were AI automation and OpenClaw."
        "Twitter skill works great. Here's what I found."
    )
    http_fut: asyncio.Future[str] = asyncio.get_event_loop().create_future()
    http_fut.set_result(full_reply)

    mock_send = AsyncMock()
    with patch("app.services.sms_session.send_sms", mock_send), \
         patch("app.services.gateway_ws.get_gateway_ws", return_value=None):
        await session._safety_delayed(asyncio.ensure_future(http_fut))

    mock_send.assert_called_once()
    sent_text = mock_send.call_args[1]["text"]
    assert "Good — the Reddit topics" not in sent_text
    assert "Twitter skill works great" in sent_text


# -- Segment boundary capture from WS events -----------------------------------

@pytest.mark.asyncio
async def test_tool_start_captures_segment():
    """Agent tool-start event finalizes the current delta text as a segment."""
    session = _SMSSession("key-ts", "+1111", "+2222")
    session.last_delta_text = "Looking into that now."

    await session.on_gateway_event("agent", {
        "stream": "tool",
        "data": {"phase": "start", "name": "web_search"},
    })

    assert session._response_segments == ["Looking into that now."]
    assert session.last_delta_text == ""


@pytest.mark.asyncio
async def test_chat_final_captures_last_segment():
    """chat.final event captures the last response segment."""
    session = _SMSSession("key-cf", "+1111", "+2222")

    await session.on_gateway_event("chat", {
        "state": "final",
        "message": {"content": [{"type": "text", "text": "Here are your results."}]},
    })

    assert session._response_segments == ["Here are your results."]


@pytest.mark.asyncio
async def test_duplicate_chat_final_deduped():
    """Duplicate chat.final events should not create duplicate segments."""
    session = _SMSSession("key-dup", "+1111", "+2222")

    final_payload = {
        "state": "final",
        "message": {"content": [{"type": "text", "text": "Here are your results."}]},
    }
    # Gateway fires the same event twice
    await session.on_gateway_event("chat", final_payload)
    await session.on_gateway_event("chat", final_payload)

    assert session._response_segments == ["Here are your results."]


# -- _extract_chat_text -------------------------------------------------------

def test_extract_chat_text_normal():
    payload = {"message": {"content": [{"type": "text", "text": "hello"}]}}
    assert _extract_chat_text(payload) == "hello"


def test_extract_chat_text_empty():
    assert _extract_chat_text({}) == ""
    assert _extract_chat_text({"message": "not-a-dict"}) == ""
    assert _extract_chat_text({"message": {"content": []}}) == ""
