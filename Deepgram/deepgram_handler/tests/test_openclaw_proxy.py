import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.openclaw_proxy import _extract_last_user_message, _filtered_stream
from app.services import session_registry


@pytest.fixture
def client():
    return TestClient(app)


def test_proxy_chat_completions_forwards_request(client, monkeypatch):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.headers = {"content-type": "application/json"}

    async def aiter_bytes():
        yield b'{"choices":[{"message":{"content":"hi"}}]}'

    mock_resp.aiter_bytes = aiter_bytes
    mock_resp.aclose = AsyncMock()

    mock_request = MagicMock()
    mock_client = AsyncMock()
    mock_client.build_request = MagicMock(return_value=mock_request)
    mock_client.send = AsyncMock(return_value=mock_resp)
    mock_client.aclose = AsyncMock()

    # Ensure no session is registered so filler logic is skipped
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.get_settings",
        lambda: __import__("app.config", fromlist=["Settings"]).Settings(
            DEEPGRAM_API_KEY="test-key",
            OPENCLAW_GATEWAY_TOKEN="gw-token",
            FILLER_THRESHOLD_MS=0,
            _env_file=None,
        ),
    )

    with patch(
        "app.routers.openclaw_proxy.httpx.AsyncClient", return_value=mock_client
    ):
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

    # Verify build_request was called with correct URL
    mock_client.build_request.assert_called_once()
    call_args = mock_client.build_request.call_args
    assert call_args[0] == ("POST", "http://localhost:18789/v1/chat/completions")


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


# ---------------------------------------------------------------------------
# _extract_last_user_message tests
# ---------------------------------------------------------------------------


def test_extract_last_user_message_simple():
    body = b'{"messages":[{"role":"user","content":"What is the weather?"}]}'
    assert _extract_last_user_message(body) == "What is the weather?"


def test_extract_last_user_message_multiple():
    body = b'{"messages":[{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi"},{"role":"user","content":"Weather?"}]}'
    assert _extract_last_user_message(body) == "Weather?"


def test_extract_last_user_message_no_user():
    body = b'{"messages":[{"role":"system","content":"You are helpful"}]}'
    assert _extract_last_user_message(body) is None


def test_extract_last_user_message_invalid_json():
    body = b"not json"
    assert _extract_last_user_message(body) is None


def test_extract_last_user_message_multimodal():
    """Multimodal content (list) extracts the text part."""
    body = b'{"messages":[{"role":"user","content":[{"type":"text","text":"Describe this"},{"type":"image_url","image_url":{}}]}]}'
    assert _extract_last_user_message(body) == "Describe this"


# ---------------------------------------------------------------------------
# Filler injection proxy tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_proxy_injects_filler_on_slow_response(monkeypatch):
    """When response is slow and a session is registered, filler is injected."""
    from httpx import AsyncClient
    from app.config import Settings

    # Register a mock Deepgram WS
    mock_dg_ws = AsyncMock()
    session_registry.register("agent:main:slow-call", mock_dg_ws)

    # Configure settings with low threshold for test speed
    test_settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        FILLER_THRESHOLD_MS=50,  # 50ms for fast test
        FILLER_PHRASES="One moment...,Working on it.",
        FILLER_DYNAMIC=False,  # Disable Haiku for this test
        _env_file=None,
    )
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.get_settings", lambda: test_settings
    )

    # Simulate a slow OpenClaw response (200ms delay before response)
    async def slow_send(request, *, stream=False):
        await asyncio.sleep(0.2)  # 200ms > 50ms threshold
        resp = MagicMock()
        resp.status_code = 200
        resp.headers = {"content-type": "text/event-stream"}

        async def aiter_bytes():
            yield b'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        resp.aiter_bytes = aiter_bytes
        resp.aclose = AsyncMock()
        return resp

    mock_client = AsyncMock()
    mock_client.build_request = MagicMock(return_value=MagicMock())
    mock_client.send = slow_send
    mock_client.aclose = AsyncMock()
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.httpx.AsyncClient", lambda **kw: mock_client
    )

    from httpx import ASGITransport

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "hello"}]},
            headers={"x-openclaw-session-key": "agent:main:slow-call"},
        )

    assert resp.status_code == 200

    # Filler should have been injected
    mock_dg_ws.send.assert_called_once()
    injected = json.loads(mock_dg_ws.send.call_args[0][0])
    assert injected["type"] == "InjectAgentMessage"
    assert injected["message"] in ["One moment...", "Working on it."]

    # Cleanup
    session_registry.unregister("agent:main:slow-call")


@pytest.mark.asyncio
async def test_proxy_skips_filler_on_fast_response(monkeypatch):
    """When response is fast, no filler is injected."""
    from httpx import AsyncClient
    from app.config import Settings

    mock_dg_ws = AsyncMock()
    session_registry.register("agent:main:fast-call", mock_dg_ws)

    test_settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        FILLER_THRESHOLD_MS=500,  # 500ms threshold
        FILLER_PHRASES="One moment...",
        FILLER_DYNAMIC=False,
        _env_file=None,
    )
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.get_settings", lambda: test_settings
    )

    # Fast response (no delay)
    async def fast_send(request, *, stream=False):
        resp = MagicMock()
        resp.status_code = 200
        resp.headers = {"content-type": "text/event-stream"}

        async def aiter_bytes():
            yield b'data: {"choices":[{"delta":{"content":"Quick response"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        resp.aiter_bytes = aiter_bytes
        resp.aclose = AsyncMock()
        return resp

    mock_client = AsyncMock()
    mock_client.build_request = MagicMock(return_value=MagicMock())
    mock_client.send = fast_send
    mock_client.aclose = AsyncMock()
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.httpx.AsyncClient", lambda **kw: mock_client
    )

    from httpx import ASGITransport

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "hello"}]},
            headers={"x-openclaw-session-key": "agent:main:fast-call"},
        )

    assert resp.status_code == 200

    # No filler should have been injected
    mock_dg_ws.send.assert_not_called()

    # Cleanup
    session_registry.unregister("agent:main:fast-call")


@pytest.mark.asyncio
async def test_proxy_skips_filler_when_no_session(monkeypatch):
    """When no session is registered for the key, no filler logic runs."""
    from httpx import AsyncClient
    from app.config import Settings

    test_settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        FILLER_THRESHOLD_MS=50,
        FILLER_PHRASES="One moment...",
        FILLER_DYNAMIC=False,
        _env_file=None,
    )
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.get_settings", lambda: test_settings
    )

    async def fast_send(request, *, stream=False):
        resp = MagicMock()
        resp.status_code = 200
        resp.headers = {"content-type": "application/json"}

        async def aiter_bytes():
            yield b'{"choices":[{"message":{"content":"hi"}}]}'

        resp.aiter_bytes = aiter_bytes
        resp.aclose = AsyncMock()
        return resp

    mock_client = AsyncMock()
    mock_client.build_request = MagicMock(return_value=MagicMock())
    mock_client.send = fast_send
    mock_client.aclose = AsyncMock()
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.httpx.AsyncClient", lambda **kw: mock_client
    )

    from httpx import ASGITransport

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "hello"}]},
            headers={"x-openclaw-session-key": "agent:main:no-session"},
        )

    # Should succeed without any filler injection (no crash, no side effects)
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_proxy_skips_filler_when_threshold_zero(monkeypatch):
    """Filler disabled when threshold is 0."""
    from httpx import AsyncClient
    from app.config import Settings

    mock_dg_ws = AsyncMock()
    session_registry.register("agent:main:disabled", mock_dg_ws)

    test_settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        FILLER_THRESHOLD_MS=0,  # Disabled
        FILLER_PHRASES="One moment...",
        FILLER_DYNAMIC=False,
        _env_file=None,
    )
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.get_settings", lambda: test_settings
    )

    async def slow_send(request, *, stream=False):
        await asyncio.sleep(0.1)
        resp = MagicMock()
        resp.status_code = 200
        resp.headers = {"content-type": "text/event-stream"}

        async def aiter_bytes():
            yield b'data: {"choices":[{"delta":{"content":"Slow"}}]}\n\n'

        resp.aiter_bytes = aiter_bytes
        resp.aclose = AsyncMock()
        return resp

    mock_client = AsyncMock()
    mock_client.build_request = MagicMock(return_value=MagicMock())
    mock_client.send = slow_send
    mock_client.aclose = AsyncMock()
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.httpx.AsyncClient", lambda **kw: mock_client
    )

    from httpx import ASGITransport

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "hello"}]},
            headers={"x-openclaw-session-key": "agent:main:disabled"},
        )

    assert resp.status_code == 200
    mock_dg_ws.send.assert_not_called()

    session_registry.unregister("agent:main:disabled")


# ---------------------------------------------------------------------------
# Mute interception tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_proxy_returns_noop_when_muted(monkeypatch):
    """When session is muted, proxy returns empty SSE response without calling gateway."""
    from httpx import AsyncClient
    from app.config import Settings

    mock_dg_ws = AsyncMock()
    session_registry.register("agent:main:muted-call", mock_dg_ws)
    session_registry.set_muted("agent:main:muted-call", True)

    test_settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        FILLER_THRESHOLD_MS=0,
        _env_file=None,
    )
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.get_settings", lambda: test_settings
    )

    # No mock client needed — the proxy should short-circuit

    from httpx import ASGITransport

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "what time is it"}]},
            headers={"x-openclaw-session-key": "agent:main:muted-call"},
        )

    assert resp.status_code == 200
    body = resp.text
    assert "data:" in body
    assert "finish_reason" in body
    assert "stop" in body

    session_registry.unregister("agent:main:muted-call")


@pytest.mark.asyncio
async def test_proxy_unmutes_on_agent_name(monkeypatch):
    """When muted and user says agent name, session is unmuted and request proxies normally."""
    from httpx import AsyncClient
    from app.config import Settings

    mock_dg_ws = AsyncMock()
    session_registry.register("agent:main:unmute-call", mock_dg_ws, agent_name="Wren")
    session_registry.set_muted("agent:main:unmute-call", True)

    test_settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        FILLER_THRESHOLD_MS=0,
        _env_file=None,
    )
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.get_settings", lambda: test_settings
    )

    # Mock the upstream gateway
    async def fast_send(request, *, stream=False):
        resp = MagicMock()
        resp.status_code = 200
        resp.headers = {"content-type": "text/event-stream"}

        async def aiter_bytes():
            yield b'data: {"choices":[{"delta":{"content":"I\'m back!"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        resp.aiter_bytes = aiter_bytes
        resp.aclose = AsyncMock()
        return resp

    mock_client = AsyncMock()
    mock_client.build_request = MagicMock(return_value=MagicMock())
    mock_client.send = fast_send
    mock_client.aclose = AsyncMock()
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.httpx.AsyncClient", lambda **kw: mock_client
    )

    from httpx import ASGITransport

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "Hey Wren, are you there?"}]},
            headers={"x-openclaw-session-key": "agent:main:unmute-call"},
        )

    assert resp.status_code == 200
    assert "I'm back!" in resp.text

    # Session should now be unmuted
    assert session_registry.is_muted("agent:main:unmute-call") is False

    session_registry.unregister("agent:main:unmute-call")


@pytest.mark.asyncio
async def test_proxy_unmutes_on_keyword(monkeypatch):
    """When muted and user says 'unmute', session is unmuted."""
    from httpx import AsyncClient
    from app.config import Settings

    mock_dg_ws = AsyncMock()
    session_registry.register("agent:main:unmute-kw", mock_dg_ws)
    session_registry.set_muted("agent:main:unmute-kw", True)

    test_settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        FILLER_THRESHOLD_MS=0,
        _env_file=None,
    )
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.get_settings", lambda: test_settings
    )

    async def fast_send(request, *, stream=False):
        resp = MagicMock()
        resp.status_code = 200
        resp.headers = {"content-type": "text/event-stream"}

        async def aiter_bytes():
            yield b'data: {"choices":[{"delta":{"content":"Unmuted!"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        resp.aiter_bytes = aiter_bytes
        resp.aclose = AsyncMock()
        return resp

    mock_client = AsyncMock()
    mock_client.build_request = MagicMock(return_value=MagicMock())
    mock_client.send = fast_send
    mock_client.aclose = AsyncMock()
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.httpx.AsyncClient", lambda **kw: mock_client
    )

    from httpx import ASGITransport

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "unmute"}]},
            headers={"x-openclaw-session-key": "agent:main:unmute-kw"},
        )

    assert resp.status_code == 200
    assert session_registry.is_muted("agent:main:unmute-kw") is False

    session_registry.unregister("agent:main:unmute-kw")


# ---------------------------------------------------------------------------
# Filler skip for short confirmations
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_proxy_skips_filler_for_confirmation(monkeypatch):
    """Short confirmations like 'Yep' should not trigger filler injection."""
    from httpx import AsyncClient
    from app.config import Settings

    # Register a mock Deepgram WS
    mock_dg_ws = AsyncMock()
    session_registry.register("agent:main:confirm-call", mock_dg_ws)

    # Configure settings with low threshold — filler WOULD fire if not skipped
    test_settings = Settings(
        DEEPGRAM_API_KEY="test-key",
        OPENCLAW_GATEWAY_TOKEN="gw-token",
        FILLER_THRESHOLD_MS=50,  # 50ms for fast test
        FILLER_PHRASES="One moment...,Working on it.",
        FILLER_DYNAMIC=False,
        _env_file=None,
    )
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.get_settings", lambda: test_settings
    )

    # Simulate a slow OpenClaw response (200ms > 50ms threshold)
    async def slow_send(request, *, stream=False):
        await asyncio.sleep(0.2)
        resp = MagicMock()
        resp.status_code = 200
        resp.headers = {"content-type": "text/event-stream"}

        async def aiter_bytes():
            yield b'data: {"choices":[{"delta":{"content":"Got it"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        resp.aiter_bytes = aiter_bytes
        resp.aclose = AsyncMock()
        return resp

    mock_client = AsyncMock()
    mock_client.build_request = MagicMock(return_value=MagicMock())
    mock_client.send = slow_send
    mock_client.aclose = AsyncMock()
    monkeypatch.setattr(
        "app.routers.openclaw_proxy.httpx.AsyncClient", lambda **kw: mock_client
    )

    from httpx import ASGITransport

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as test_client:
        resp = await test_client.post(
            "/v1/chat/completions",
            json={"model": "test", "messages": [{"role": "user", "content": "Yep"}]},
            headers={"x-openclaw-session-key": "agent:main:confirm-call"},
        )

    assert resp.status_code == 200

    # Filler should NOT have been injected (confirmation detected)
    mock_dg_ws.send.assert_not_called()

    # Cleanup
    session_registry.unregister("agent:main:confirm-call")
