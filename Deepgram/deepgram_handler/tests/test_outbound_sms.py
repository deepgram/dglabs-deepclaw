from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.outbound_sms import send_sms


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_response(json_body: dict, status_code: int = 200) -> MagicMock:
    """Build a mock httpx.Response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = str(json_body)[:300]
    resp.json.return_value = json_body
    resp.raise_for_status = MagicMock()
    return resp


def _mock_async_client(response: MagicMock) -> AsyncMock:
    """Build a mock httpx.AsyncClient that returns *response* on POST."""
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    return client


def _settings_with_proxy():
    """Mock settings with TWILIO_PROXY_URL set (proxy mode)."""
    s = MagicMock()
    s.TWILIO_PROXY_URL = "http://test-control-plane"
    return s


def _settings_with_twilio_direct():
    """Mock settings with direct Twilio creds (no proxy)."""
    s = MagicMock()
    s.TWILIO_PROXY_URL = ""
    s.TWILIO_ACCOUNT_SID = "AC_test_sid"
    s.TWILIO_AUTH_TOKEN = "test_auth_token"
    s.TWILIO_FROM_NUMBER = "+15559990000"
    return s


def _settings_no_creds():
    """Mock settings with neither proxy nor Twilio creds."""
    s = MagicMock()
    s.TWILIO_PROXY_URL = ""
    s.TWILIO_ACCOUNT_SID = ""
    s.TWILIO_AUTH_TOKEN = ""
    s.TWILIO_FROM_NUMBER = ""
    return s


# ---------------------------------------------------------------------------
# Proxy mode tests
# ---------------------------------------------------------------------------

async def test_send_sms_posts_to_control_plane():
    """Verify correct URL, JSON body, and response via proxy."""
    expected = {"sid": "SM123", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with (
        patch("app.services.outbound_sms.get_settings", return_value=_settings_with_proxy()),
        patch("app.services.outbound_sms.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await send_sms(to="+15551234567", text="Hello!", from_number="+15559876543")

    assert result == expected

    mock_client.post.assert_called_once()
    call_args = mock_client.post.call_args
    assert call_args[0][0] == "http://test-control-plane/api/sms/send"

    body = call_args[1]["json"]
    assert body["to"] == "+15551234567"
    assert body["text"] == "Hello!"
    assert body["from"] == "+15559876543"
    assert "mediaUrls" not in body


async def test_send_sms_with_media_urls_proxy():
    """Verify mediaUrls included when provided (proxy mode)."""
    expected = {"sid": "SM456", "status": "queued"}
    media = ["https://example.com/cat.jpg"]
    mock_client = _mock_async_client(_mock_response(expected))

    with (
        patch("app.services.outbound_sms.get_settings", return_value=_settings_with_proxy()),
        patch("app.services.outbound_sms.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await send_sms(
            to="+15551234567",
            text="Look at this cat!",
            media_urls=media,
        )

    assert result == expected

    body = mock_client.post.call_args[1]["json"]
    assert body["mediaUrls"] == media


async def test_send_sms_raises_on_error_proxy():
    """HTTP error propagated via raise_for_status (proxy mode)."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Server Error",
        request=MagicMock(),
        response=MagicMock(status_code=500),
    )
    mock_client = _mock_async_client(mock_resp)

    with (
        patch("app.services.outbound_sms.get_settings", return_value=_settings_with_proxy()),
        patch("app.services.outbound_sms.httpx.AsyncClient", return_value=mock_client),
    ):
        with pytest.raises(httpx.HTTPStatusError):
            await send_sms(to="+15551234567", text="fail")


# ---------------------------------------------------------------------------
# Direct Twilio mode tests
# ---------------------------------------------------------------------------

async def test_send_sms_direct_twilio():
    """Verify direct Twilio API call when no proxy URL."""
    expected = {"sid": "SM789", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with (
        patch("app.services.outbound_sms.get_settings", return_value=_settings_with_twilio_direct()),
        patch("app.services.outbound_sms.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await send_sms(to="+15551234567", text="Hello direct!")

    assert result == expected

    mock_client.post.assert_called_once()
    call_args = mock_client.post.call_args

    # Should target Twilio REST API
    assert "api.twilio.com" in call_args[0][0]
    assert "/Messages.json" in call_args[0][0]
    assert "AC_test_sid" in call_args[0][0]

    # Should use form data (not JSON)
    form_data = call_args[1]["data"]
    assert ("To", "+15551234567") in form_data
    assert ("From", "+15559990000") in form_data
    assert ("Body", "Hello direct!") in form_data

    # Should use basic auth
    auth = call_args[1]["auth"]
    assert auth == ("AC_test_sid", "test_auth_token")


async def test_send_sms_direct_twilio_with_media():
    """Verify MMS media URLs sent as repeated MediaUrl form fields."""
    expected = {"sid": "SM_mms", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))
    media = ["https://example.com/a.jpg", "https://example.com/b.jpg"]

    with (
        patch("app.services.outbound_sms.get_settings", return_value=_settings_with_twilio_direct()),
        patch("app.services.outbound_sms.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await send_sms(to="+15551234567", text="MMS!", media_urls=media)

    assert result == expected

    form_data = mock_client.post.call_args[1]["data"]
    media_entries = [v for k, v in form_data if k == "MediaUrl"]
    assert media_entries == media


async def test_send_sms_direct_uses_from_number_override():
    """Explicit from_number overrides TWILIO_FROM_NUMBER."""
    expected = {"sid": "SM_override", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with (
        patch("app.services.outbound_sms.get_settings", return_value=_settings_with_twilio_direct()),
        patch("app.services.outbound_sms.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await send_sms(
            to="+15551234567", text="Hello!", from_number="+15550001111",
        )

    form_data = mock_client.post.call_args[1]["data"]
    assert ("From", "+15550001111") in form_data


# ---------------------------------------------------------------------------
# No credentials tests
# ---------------------------------------------------------------------------

async def test_send_sms_no_creds_raises():
    """No proxy and no direct Twilio creds raises ValueError."""
    with patch("app.services.outbound_sms.get_settings", return_value=_settings_no_creds()):
        with pytest.raises(ValueError, match="Neither TWILIO_PROXY_URL nor direct Twilio"):
            await send_sms(to="+15551234567", text="should fail")


async def test_send_sms_no_from_number_raises():
    """Direct mode with no from number raises ValueError."""
    s = _settings_with_twilio_direct()
    s.TWILIO_FROM_NUMBER = ""

    with patch("app.services.outbound_sms.get_settings", return_value=s):
        with pytest.raises(ValueError, match="No sender number"):
            await send_sms(to="+15551234567", text="should fail")
