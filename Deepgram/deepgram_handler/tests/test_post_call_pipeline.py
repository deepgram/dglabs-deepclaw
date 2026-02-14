"""Tests for transcript capture and post-call pipeline triggering."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.workspace import TranscriptEntry


async def _async_iter(items):
    """Helper: yield items as an async iterator."""
    for item in items:
        yield item


def _mock_dg_ws(messages):
    """Create a mock Deepgram WS that yields messages as an async iterator."""
    mock = AsyncMock()
    mock.__aiter__ = lambda self: _async_iter(messages)
    return mock


@pytest.mark.asyncio
async def test_conversation_text_captured_in_transcript():
    """ConversationText events from Deepgram are recorded in the transcript list."""
    from app.services.deepgram_agent import _deepgram_to_twilio

    transcript: list[TranscriptEntry] = []
    stop_event = MagicMock()
    stop_event.is_set = MagicMock(return_value=False)

    messages = [
        json.dumps(
            {"type": "ConversationText", "role": "assistant", "content": "Hello!"}
        ),
        json.dumps({"type": "ConversationText", "role": "user", "content": "Hi there"}),
    ]

    mock_twilio_ws = AsyncMock()

    await _deepgram_to_twilio(
        _mock_dg_ws(messages), mock_twilio_ws, "test-stream", stop_event, transcript
    )

    assert len(transcript) == 2
    assert transcript[0].speaker == "bot"
    assert transcript[0].text == "Hello!"
    assert transcript[1].speaker == "user"
    assert transcript[1].text == "Hi there"


@pytest.mark.asyncio
async def test_transcript_none_does_not_crash():
    """When transcript is None, ConversationText events are still logged without error."""
    from app.services.deepgram_agent import _deepgram_to_twilio

    stop_event = MagicMock()
    stop_event.is_set = MagicMock(return_value=False)

    messages = [
        json.dumps({"type": "ConversationText", "role": "user", "content": "Hey"}),
    ]

    mock_twilio_ws = AsyncMock()

    # Should not raise
    await _deepgram_to_twilio(
        _mock_dg_ws(messages), mock_twilio_ws, "stream", stop_event, None
    )


@pytest.mark.asyncio
async def test_non_conversation_events_not_captured():
    """Non-ConversationText events should not be added to transcript."""
    from app.services.deepgram_agent import _deepgram_to_twilio

    transcript: list[TranscriptEntry] = []
    stop_event = MagicMock()
    stop_event.is_set = MagicMock(return_value=False)

    messages = [
        json.dumps({"type": "UserStartedSpeaking"}),
        json.dumps({"type": "Warning", "description": "test warning"}),
    ]

    mock_twilio_ws = AsyncMock()

    await _deepgram_to_twilio(
        _mock_dg_ws(messages), mock_twilio_ws, "stream", stop_event, transcript
    )

    assert len(transcript) == 0
