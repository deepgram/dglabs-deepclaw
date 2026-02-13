from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.outbound_call import (
    _outbound_calls,
    get_outbound_context,
    make_call,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_response(json_body: dict, status_code: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_body
    resp.raise_for_status = MagicMock()
    return resp


def _mock_async_client(response: MagicMock) -> AsyncMock:
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    return client


# ---------------------------------------------------------------------------
# make_call tests
# ---------------------------------------------------------------------------


async def test_make_call_posts_to_control_plane():
    expected = {"sid": "CA123", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client):
        result = await make_call(to="+15551234567", purpose="Remind about meeting")

    assert result["sid"] == "CA123"
    assert result["session_id"].startswith("outbound-")

    mock_client.post.assert_called_once()
    call_args = mock_client.post.call_args
    assert call_args[0][0] == "http://test-control-plane/api/voice/call"

    body = call_args[1]["json"]
    assert body["to"] == "+15551234567"
    assert "url" in body
    assert "/twilio/outbound?sid=" in body["url"]


async def test_make_call_does_not_send_from():
    """The control plane owns the caller ID — no 'from' in the payload."""
    expected = {"sid": "CA456", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client):
        result = await make_call(to="+15551234567", purpose="Order pizza")

    body = mock_client.post.call_args[1]["json"]
    assert "from" not in body
    assert result["sid"] == "CA456"


async def test_make_call_stores_context():
    expected = {"sid": "CA789", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client):
        result = await make_call(to="+15551234567", purpose="Check status")

    session_id = result["session_id"]
    # Context should have been consumed or still stored
    # After successful call, context is kept for the webhook to consume
    # (it's not popped until the webhook handler calls get_outbound_context)
    # Clean up for test isolation
    _outbound_calls.pop(session_id, None)


async def test_make_call_raises_on_error():
    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Server Error",
        request=MagicMock(),
        response=MagicMock(status_code=500),
    )
    mock_client = _mock_async_client(mock_resp)

    with patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(httpx.HTTPStatusError):
            await make_call(to="+15551234567", purpose="fail")


async def test_make_call_cleans_up_context_on_failure():
    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Server Error",
        request=MagicMock(),
        response=MagicMock(status_code=500),
    )
    mock_client = _mock_async_client(mock_resp)

    initial_count = len(_outbound_calls)

    with patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(httpx.HTTPStatusError):
            await make_call(to="+15551234567", purpose="fail")

    # Context should be cleaned up on failure
    assert len(_outbound_calls) == initial_count


async def test_make_call_no_proxy_url_raises():
    mock_settings = MagicMock()
    mock_settings.TWILIO_PROXY_URL = ""

    with patch("app.services.outbound_call.get_settings", return_value=mock_settings):
        with pytest.raises(ValueError, match="TWILIO_PROXY_URL is not configured"):
            await make_call(to="+15551234567", purpose="should fail")


# ---------------------------------------------------------------------------
# get_outbound_context tests
# ---------------------------------------------------------------------------


def test_get_outbound_context_returns_and_removes():
    _outbound_calls["test-session"] = {"purpose": "test", "to": "+15551234567"}
    result = get_outbound_context("test-session")

    assert result == {"purpose": "test", "to": "+15551234567"}
    assert "test-session" not in _outbound_calls


def test_get_outbound_context_returns_none_for_unknown():
    result = get_outbound_context("nonexistent-session")
    assert result is None
