import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services.filler import (
    FILLER_SKIP,
    generate_filler_phrase,
    is_short_confirmation,
)

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"


@pytest.mark.asyncio
async def test_generate_filler_phrase_success():
    """Returns a phrase on successful Anthropic response."""
    mock_response = httpx.Response(
        200,
        json={
            "content": [{"type": "text", "text": "Let me look into that."}],
            "model": "claude-haiku-4-5-20251001",
            "role": "assistant",
        },
        request=httpx.Request("POST", ANTHROPIC_URL),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("What's the weather like?", "sk-ant-test")

    assert result == "Let me look into that."

    # Verify direct Anthropic API call
    call_kwargs = mock_client.post.call_args[1]
    assert call_kwargs["headers"]["x-api-key"] == "sk-ant-test"
    assert call_kwargs["headers"]["anthropic-version"] == "2023-06-01"
    body = call_kwargs["json"]
    assert body["model"] == "claude-haiku-4-5-20251001"
    assert body["max_tokens"] == 50
    assert "weather" in body["messages"][0]["content"]


@pytest.mark.asyncio
async def test_generate_filler_phrase_includes_user_message_in_prompt():
    """The prompt references the user's actual message."""
    mock_response = httpx.Response(
        200,
        json={
            "content": [{"type": "text", "text": "Checking on that."}],
            "role": "assistant",
        },
        request=httpx.Request("POST", ANTHROPIC_URL),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        await generate_filler_phrase("Schedule a meeting for Tuesday", "sk-ant-test")

    prompt = mock_client.post.call_args[1]["json"]["messages"][0]["content"]
    assert "Schedule a meeting for Tuesday" in prompt


@pytest.mark.asyncio
async def test_generate_filler_phrase_network_error():
    """Returns None on network failure."""
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(side_effect=httpx.ConnectError("connection refused"))

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Hello", "sk-ant-test")

    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_non_ok_status():
    """Returns None on HTTP error response."""
    mock_response = httpx.Response(
        500,
        json={"error": {"type": "internal_error", "message": "Internal server error"}},
        request=httpx.Request("POST", ANTHROPIC_URL),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Hello", "sk-ant-test")

    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_empty_api_key():
    """Returns None immediately if API key is empty."""
    result = await generate_filler_phrase("Hello", "")
    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_empty_content():
    """Returns None if response has no content blocks."""
    mock_response = httpx.Response(
        200,
        json={"content": [], "role": "assistant"},
        request=httpx.Request("POST", ANTHROPIC_URL),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Hello", "sk-ant-test")

    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_timeout():
    """Returns None if Anthropic call exceeds hard timeout."""

    async def slow_post(*args, **kwargs):
        await asyncio.sleep(5.0)  # Way past the 2s timeout
        return httpx.Response(
            200,
            json={"content": [{"type": "text", "text": "Late."}]},
        )

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = slow_post

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Hello", "sk-ant-test")

    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_strips_whitespace():
    """Strips leading/trailing whitespace from the response."""
    mock_response = httpx.Response(
        200,
        json={
            "content": [{"type": "text", "text": "  Let me check.  \n"}],
            "role": "assistant",
        },
        request=httpx.Request("POST", ANTHROPIC_URL),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Hello", "sk-ant-test")

    assert result == "Let me check."


# ---------------------------------------------------------------------------
# Short confirmation detection tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "message",
    [
        "Yep",
        "Exactly",
        "That's okay",
        "Sounds good",
        "Yeah",
        "Ok",
        "Sure",
        "Right",
        "Correct",
        "Absolutely",
        "Definitely",
        "Got it",
        "Perfect",
        "Cool",
        "Alright",
        "Makes sense",
        "Agreed",
        "Indeed",
        "yep.",
        "Exactly!",
        "That's fine",
        "That's great",
        "That's perfect",
        "No worries",
        "All good",
        "Of course",
        "For sure",
        "That works",
        "Fair enough",
        "I see",
    ],
)
def test_detects_confirmations(message):
    assert is_short_confirmation(message) is True


@pytest.mark.parametrize(
    "message",
    [
        "Can you check my email?",
        "What's the weather like in San Francisco today?",
        "",
        "   ",
        "This is a much longer message that exceeds the word limit for confirmation",
        "Tell me about the project status and what we need to do next",
    ],
)
def test_rejects_non_confirmations(message):
    assert is_short_confirmation(message) is False


@pytest.mark.asyncio
async def test_generate_filler_phrase_returns_skip():
    """When Haiku returns 'SKIP', generate_filler_phrase returns FILLER_SKIP."""
    mock_response = httpx.Response(
        200,
        json={
            "content": [{"type": "text", "text": "SKIP"}],
            "role": "assistant",
        },
        request=httpx.Request("POST", ANTHROPIC_URL),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Yep", "sk-ant-test")

    assert result == FILLER_SKIP
