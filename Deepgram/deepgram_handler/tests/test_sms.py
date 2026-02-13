import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.sms_context import FALLBACK_MESSAGE, HOLDING_MESSAGE

_NO_USER_MD = patch("app.services.sms_context.USER_MD_PATH", Path("/nonexistent/USER.md"))


@pytest.fixture
def client():
    return TestClient(app)


def test_inbound_sms_routes_through_openclaw(client):
    with (
        patch("app.routers.sms.ask_openclaw", AsyncMock(return_value="Hello from OpenClaw!")),
        _NO_USER_MD,
    ):
        response = client.post(
            "/twilio/inbound-sms",
            data={"From": "+15551234567", "Body": "hello", "MessageSid": "SM123"},
        )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/xml"
    assert "<Message>Hello from OpenClaw!</Message>" in response.text


def test_inbound_mms_image_sent_as_multimodal(client):
    """MMS with image should pass multimodal content through to ask_openclaw."""
    mock_ask = AsyncMock(return_value="Nice photo!")
    fake_content = [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc123"}},
    ]

    with (
        patch("app.routers.sms.ask_openclaw", mock_ask),
        patch("app.routers.sms.build_message_content", AsyncMock(return_value=fake_content)),
        _NO_USER_MD,
    ):
        response = client.post(
            "/twilio/inbound-sms",
            data={
                "From": "+15551234567",
                "Body": "",
                "MessageSid": "SM789",
                "NumMedia": "1",
                "MediaUrl0": "https://api.twilio.com/media/img.png",
                "MediaContentType0": "image/png",
            },
        )

    assert response.status_code == 200
    assert "<Message>Nice photo!</Message>" in response.text

    # Verify multimodal content was forwarded to ask_openclaw
    call_args = mock_ask.call_args
    assert call_args[0][2] is fake_content


def test_inbound_sms_openclaw_error_returns_fallback(client):
    with patch("app.routers.sms.ask_openclaw", AsyncMock(side_effect=Exception("connection refused"))):
        response = client.post(
            "/twilio/inbound-sms",
            data={"From": "+15551234567", "Body": "hello", "MessageSid": "SM123"},
        )

    assert response.status_code == 200
    assert FALLBACK_MESSAGE in response.text


def test_inbound_sms_timeout_sends_holding_then_delayed(client):
    """When OpenClaw exceeds the reply timeout, return holding message and fire delayed reply."""

    async def _slow(*a, **kw):
        await asyncio.sleep(10)
        return "Late response"

    mock_delayed = AsyncMock()

    with (
        patch("app.routers.sms.ask_openclaw", side_effect=_slow),
        patch("app.routers.sms.TWILIO_REPLY_TIMEOUT", 0.01),
        patch("app.routers.sms.send_delayed_reply", mock_delayed),
    ):
        response = client.post(
            "/twilio/inbound-sms",
            data={"From": "+15551234567", "Body": "long question", "MessageSid": "SM999"},
        )

    assert response.status_code == 200
    assert HOLDING_MESSAGE in response.text
    mock_delayed.assert_called_once()


def test_inbound_sms_long_reply_truncated(client):
    """Replies longer than 1600 chars should be truncated."""
    long_reply = "A" * 800 + ".\n" + "B" * 900

    with (
        patch("app.routers.sms.ask_openclaw", AsyncMock(return_value=long_reply)),
        _NO_USER_MD,
    ):
        response = client.post(
            "/twilio/inbound-sms",
            data={"From": "+15551234567", "Body": "tell me everything", "MessageSid": "SM888"},
        )

    assert response.status_code == 200
    # Should have truncated at the newline
    assert "BBBBB" not in response.text
    assert "AAAAA" in response.text
