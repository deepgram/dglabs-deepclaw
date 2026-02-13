from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.openclaw_proxy import _filtered_stream


@pytest.fixture
def client():
    return TestClient(app)


def test_proxy_chat_completions_forwards_request(client):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.content = b'{"choices":[{"message":{"content":"hi"}}]}'
    mock_resp.headers = {"content-type": "application/json"}

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("app.routers.openclaw_proxy.httpx.AsyncClient", return_value=mock_client):
        response = client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "hello"}]},
            headers={
                "Authorization": "Bearer test-token",
                "x-openclaw-session-key": "agent:main:abc123",
            },
        )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "hi"

    # Verify forwarded to localhost OpenClaw
    mock_client.post.assert_called_once()
    call_args = mock_client.post.call_args
    assert call_args[0][0] == "http://localhost:18789/v1/chat/completions"
    headers = call_args[1]["headers"]
    assert headers["authorization"] == "Bearer test-token"
    assert headers["x-openclaw-session-key"] == "agent:main:abc123"


# ---------------------------------------------------------------------------
# _filtered_stream tests
# ---------------------------------------------------------------------------


async def _collect(async_iter):
    """Helper: collect an async iterator into a single bytes object."""
    parts = []
    async for chunk in async_iter:
        parts.append(chunk)
    return b"".join(parts)


async def _async_chunks(chunks: list[bytes]):
    """Helper: turn a list of byte chunks into an async iterator."""
    for c in chunks:
        yield c


@pytest.mark.asyncio
async def test_filtered_stream_strips_current_message_marker():
    raw = b'data: {"choices":[{"delta":{"content":"[Current message - respond to this]Hello"}}]}\n\n'
    result = await _collect(_filtered_stream(_async_chunks([raw])))
    assert b"[Current message - respond to this]" not in result
    assert b"Hello" in result


@pytest.mark.asyncio
async def test_filtered_stream_strips_history_marker():
    raw = b'data: {"choices":[{"delta":{"content":"[Chat messages since your last reply - for context]Hi"}}]}\n\n'
    result = await _collect(_filtered_stream(_async_chunks([raw])))
    assert b"[Chat messages since your last reply - for context]" not in result
    assert b"Hi" in result


@pytest.mark.asyncio
async def test_filtered_stream_marker_split_across_chunks():
    """Marker split across two chunks is still stripped."""
    chunk1 = b'data: {"choices":[{"delta":{"content":"[Current message - '
    chunk2 = b'respond to this]Hello"}}]}\n\n'
    result = await _collect(_filtered_stream(_async_chunks([chunk1, chunk2])))
    assert b"[Current message - respond to this]" not in result
    assert b"Hello" in result


@pytest.mark.asyncio
async def test_filtered_stream_no_marker_passes_through():
    raw = b'data: {"choices":[{"delta":{"content":"Just a normal response"}}]}\n\n'
    result = await _collect(_filtered_stream(_async_chunks([raw])))
    assert b"Just a normal response" in result


@pytest.mark.asyncio
async def test_filtered_stream_preserves_done_sentinel():
    chunks = [
        b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        b"data: [DONE]\n\n",
    ]
    result = await _collect(_filtered_stream(_async_chunks(chunks)))
    assert b"hi" in result
    assert b"[DONE]" in result
