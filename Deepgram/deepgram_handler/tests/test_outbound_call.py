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
    resp.text = str(json_body)[:300]
    resp.json.return_value = json_body
    resp.raise_for_status = MagicMock()
    return resp


def _mock_async_client(response: MagicMock) -> AsyncMock:
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    return client


def _settings_with_proxy():
    """Mock settings with TWILIO_PROXY_URL set (proxy mode)."""
    s = MagicMock()
    s.TWILIO_PROXY_URL = "http://test-control-plane"
    s.PUBLIC_URL = "https://test.ngrok.io"
    return s


def _settings_with_twilio_direct():
    """Mock settings with direct Twilio creds (no proxy)."""
    s = MagicMock()
    s.TWILIO_PROXY_URL = ""
    s.TWILIO_ACCOUNT_SID = "AC_test_sid"
    s.TWILIO_AUTH_TOKEN = "test_auth_token"
    s.TWILIO_FROM_NUMBER = "+15559990000"
    s.PUBLIC_URL = "https://test.ngrok.io"
    return s


def _settings_no_creds():
    """Mock settings with neither proxy nor Twilio creds."""
    s = MagicMock()
    s.TWILIO_PROXY_URL = ""
    s.TWILIO_ACCOUNT_SID = ""
    s.TWILIO_AUTH_TOKEN = ""
    s.TWILIO_FROM_NUMBER = ""
    s.PUBLIC_URL = "https://test.ngrok.io"
    return s


# ---------------------------------------------------------------------------
# Proxy mode tests
# ---------------------------------------------------------------------------


async def test_make_call_posts_to_control_plane():
    expected = {"sid": "CA123", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with (
        patch("app.services.outbound_call.get_settings", return_value=_settings_with_proxy()),
        patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client),
    ):
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

    # Clean up
    _outbound_calls.pop(result["session_id"], None)


async def test_make_call_does_not_send_from_in_proxy_mode():
    """The control plane owns the caller ID — no 'from' in the proxy payload."""
    expected = {"sid": "CA456", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with (
        patch("app.services.outbound_call.get_settings", return_value=_settings_with_proxy()),
        patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await make_call(to="+15551234567", purpose="Order pizza")

    body = mock_client.post.call_args[1]["json"]
    assert "from" not in body
    assert result["sid"] == "CA456"

    _outbound_calls.pop(result["session_id"], None)


async def test_make_call_stores_context():
    expected = {"sid": "CA789", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with (
        patch("app.services.outbound_call.get_settings", return_value=_settings_with_proxy()),
        patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await make_call(to="+15551234567", purpose="Check status")

    session_id = result["session_id"]
    _outbound_calls.pop(session_id, None)


async def test_make_call_raises_on_error_proxy():
    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Server Error",
        request=MagicMock(),
        response=MagicMock(status_code=500),
    )
    mock_client = _mock_async_client(mock_resp)

    with (
        patch("app.services.outbound_call.get_settings", return_value=_settings_with_proxy()),
        patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client),
    ):
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

    with (
        patch("app.services.outbound_call.get_settings", return_value=_settings_with_proxy()),
        patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client),
    ):
        with pytest.raises(httpx.HTTPStatusError):
            await make_call(to="+15551234567", purpose="fail")

    assert len(_outbound_calls) == initial_count


# ---------------------------------------------------------------------------
# Direct Twilio mode tests
# ---------------------------------------------------------------------------


async def test_make_call_direct_twilio():
    """Verify direct Twilio API call when no proxy URL."""
    expected = {"sid": "CA_direct", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with (
        patch("app.services.outbound_call.get_settings", return_value=_settings_with_twilio_direct()),
        patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await make_call(to="+15551234567", purpose="Test direct call")

    assert result["sid"] == "CA_direct"
    assert result["session_id"].startswith("outbound-")

    call_args = mock_client.post.call_args

    # Should target Twilio REST API
    assert "api.twilio.com" in call_args[0][0]
    assert "/Calls.json" in call_args[0][0]
    assert "AC_test_sid" in call_args[0][0]

    # Should use form data with From number
    form_data = call_args[1]["data"]
    assert form_data["To"] == "+15551234567"
    assert form_data["From"] == "+15559990000"
    assert "/twilio/outbound?sid=" in form_data["Url"]

    # Should use basic auth
    auth = call_args[1]["auth"]
    assert auth == ("AC_test_sid", "test_auth_token")

    _outbound_calls.pop(result["session_id"], None)


async def test_make_call_direct_cleans_up_on_failure():
    """Context cleaned up on direct Twilio API failure."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Bad Request",
        request=MagicMock(),
        response=MagicMock(status_code=400),
    )
    mock_client = _mock_async_client(mock_resp)

    initial_count = len(_outbound_calls)

    with (
        patch("app.services.outbound_call.get_settings", return_value=_settings_with_twilio_direct()),
        patch("app.services.outbound_call.httpx.AsyncClient", return_value=mock_client),
    ):
        with pytest.raises(httpx.HTTPStatusError):
            await make_call(to="+15551234567", purpose="fail direct")

    assert len(_outbound_calls) == initial_count


# ---------------------------------------------------------------------------
# No credentials tests
# ---------------------------------------------------------------------------


async def test_make_call_no_creds_raises():
    """No proxy and no direct Twilio creds raises ValueError."""
    with patch("app.services.outbound_call.get_settings", return_value=_settings_no_creds()):
        with pytest.raises(ValueError, match="Neither TWILIO_PROXY_URL nor direct Twilio"):
            await make_call(to="+15551234567", purpose="should fail")


async def test_make_call_no_from_number_raises():
    """Direct mode with no from number raises ValueError."""
    s = _settings_with_twilio_direct()
    s.TWILIO_FROM_NUMBER = ""

    with patch("app.services.outbound_call.get_settings", return_value=s):
        with pytest.raises(ValueError, match="No sender number"):
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
