import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services.filler import generate_filler_phrase


@pytest.mark.asyncio
async def test_generate_filler_phrase_success():
    """Returns a phrase on successful gateway response."""
    mock_response = httpx.Response(
        200,
        json={
            "choices": [
                {"message": {"content": "Let me look into that.", "role": "assistant"}}
            ],
        },
        request=httpx.Request("POST", "http://localhost:18789/v1/chat/completions"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("What's the weather like?", "gw-token")

    assert result == "Let me look into that."

    # Verify API call details
    call_kwargs = mock_client.post.call_args[1]
    assert call_kwargs["headers"]["Authorization"] == "Bearer gw-token"
    body = call_kwargs["json"]
    assert body["model"] == "litellm/claude-haiku-4-5-20251001"
    assert body["max_tokens"] == 50
    assert body["stream"] is False
    assert "weather" in body["messages"][0]["content"]


@pytest.mark.asyncio
async def test_generate_filler_phrase_includes_user_message_in_prompt():
    """The prompt references the user's actual message."""
    mock_response = httpx.Response(
        200,
        json={
            "choices": [
                {"message": {"content": "Checking on that.", "role": "assistant"}}
            ]
        },
        request=httpx.Request("POST", "http://localhost:18789/v1/chat/completions"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        await generate_filler_phrase("Schedule a meeting for Tuesday", "gw-token")

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
        result = await generate_filler_phrase("Hello", "gw-token")

    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_non_ok_status():
    """Returns None on HTTP error response."""
    mock_response = httpx.Response(
        500,
        json={"error": "internal"},
        request=httpx.Request("POST", "http://localhost:18789/v1/chat/completions"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Hello", "gw-token")

    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_empty_gateway_token():
    """Returns None immediately if gateway token is empty."""
    result = await generate_filler_phrase("Hello", "")
    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_empty_choices():
    """Returns None if response has no choices."""
    mock_response = httpx.Response(
        200,
        json={"choices": []},
        request=httpx.Request("POST", "http://localhost:18789/v1/chat/completions"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Hello", "gw-token")

    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_timeout():
    """Returns None if gateway call exceeds hard timeout."""

    async def slow_post(*args, **kwargs):
        await asyncio.sleep(5.0)  # Way past the 2s timeout
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "Late.", "role": "assistant"}}]},
        )

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = slow_post

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Hello", "gw-token")

    assert result is None


@pytest.mark.asyncio
async def test_generate_filler_phrase_strips_whitespace():
    """Strips leading/trailing whitespace from the response."""
    mock_response = httpx.Response(
        200,
        json={
            "choices": [
                {
                    "message": {
                        "content": "  Let me check.  \n",
                        "role": "assistant",
                    }
                }
            ]
        },
        request=httpx.Request("POST", "http://localhost:18789/v1/chat/completions"),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("app.services.filler.httpx.AsyncClient", return_value=mock_client):
        result = await generate_filler_phrase("Hello", "gw-token")

    assert result == "Let me check."
