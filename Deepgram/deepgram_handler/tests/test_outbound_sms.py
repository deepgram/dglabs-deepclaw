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


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_send_sms_posts_to_control_plane():
    """Verify correct URL, JSON body, and response."""
    expected = {"sid": "SM123", "status": "queued"}
    mock_client = _mock_async_client(_mock_response(expected))

    with patch("app.services.outbound_sms.httpx.AsyncClient", return_value=mock_client):
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


async def test_send_sms_with_media_urls():
    """Verify mediaUrls included when provided."""
    expected = {"sid": "SM456", "status": "queued"}
    media = ["https://example.com/cat.jpg"]
    mock_client = _mock_async_client(_mock_response(expected))

    with patch("app.services.outbound_sms.httpx.AsyncClient", return_value=mock_client):
        result = await send_sms(
            to="+15551234567",
            text="Look at this cat!",
            media_urls=media,
        )

    assert result == expected

    body = mock_client.post.call_args[1]["json"]
    assert body["mediaUrls"] == media


async def test_send_sms_raises_on_error():
    """HTTP error propagated via raise_for_status."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Server Error",
        request=MagicMock(),
        response=MagicMock(status_code=500),
    )
    mock_client = _mock_async_client(mock_resp)

    with patch("app.services.outbound_sms.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(httpx.HTTPStatusError):
            await send_sms(to="+15551234567", text="fail")


async def test_send_sms_no_proxy_url_raises():
    """Empty TWILIO_PROXY_URL raises ValueError."""
    mock_settings = MagicMock()
    mock_settings.TWILIO_PROXY_URL = ""

    with patch("app.services.outbound_sms.get_settings", return_value=mock_settings):
        with pytest.raises(ValueError, match="TWILIO_PROXY_URL is not configured"):
            await send_sms(to="+15551234567", text="should fail")
