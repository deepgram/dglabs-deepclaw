from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app

# Point USER_MD_PATH to a nonexistent file so tests always get the new-user prompt.
_NO_USER_MD = patch("app.services.sms_context.USER_MD_PATH", Path("/nonexistent/USER.md"))


@pytest.fixture
def client():
    return TestClient(app)


def _mock_openclaw_response(content: str):
    """Build a mock httpx.Response for OpenClaw chat completions."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": content}}]
    }
    mock_resp.raise_for_status = MagicMock()
    return mock_resp


def test_proxy_inbound_sms_returns_reply(client):
    """Mock OpenClaw response, verify JSON reply and correct OpenClaw call."""
    mock_resp = _mock_openclaw_response("Hello from OpenClaw!")
    mock_client = AsyncMock()
    mock_client.post.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with (
        patch("app.routers.proxy.httpx.AsyncClient", return_value=mock_client),
        _NO_USER_MD,
    ):
        response = client.post(
            "/proxy/inbound-sms",
            data={"From": "+15551234567", "Body": "hello", "MessageSid": "SM123"},
            headers={
                "X-Twilio-Account-Sid": "AC_test_sid",
                "X-Twilio-Auth-Token": "test_auth_token",
            },
        )

    assert response.status_code == 200
    assert response.json() == {"reply": "Hello from OpenClaw!"}

    # Verify the call to OpenClaw
    mock_client.post.assert_called_once()
    call_args = mock_client.post.call_args
    assert call_args[0][0] == "http://localhost:18789/v1/chat/completions"
    headers = call_args[1]["headers"]
    assert headers["Authorization"] == "Bearer test-token"
    assert headers["x-openclaw-session-key"].startswith("agent:main:sms-")
    body = call_args[1]["json"]
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][1]["role"] == "user"
    assert body["messages"][1]["content"] == "hello"


def test_proxy_inbound_sms_openclaw_error_returns_fallback(client):
    """OpenClaw fails, verify fallback reply."""
    mock_client = AsyncMock()
    mock_client.post.side_effect = Exception("connection refused")
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("app.routers.proxy.httpx.AsyncClient", return_value=mock_client):
        response = client.post(
            "/proxy/inbound-sms",
            data={"From": "+15551234567", "Body": "hello", "MessageSid": "SM123"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "reply": "Hey! I'm just getting set up — text me again in a minute and I'll be ready to chat."
    }


def test_proxy_inbound_mms_sends_multimodal_content(client):
    """Verify MMS with image is sent as multimodal content to OpenClaw."""
    mock_resp = _mock_openclaw_response("Got your image!")
    mock_client = AsyncMock()
    mock_client.post.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    fake_content = [
        {"type": "text", "text": "check this out"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,abc123"}},
    ]

    with (
        patch("app.routers.proxy.httpx.AsyncClient", return_value=mock_client),
        patch("app.routers.proxy.build_message_content", return_value=fake_content),
        _NO_USER_MD,
    ):
        response = client.post(
            "/proxy/inbound-sms",
            data={
                "From": "+15551234567",
                "Body": "check this out",
                "MessageSid": "SM456",
                "NumMedia": "1",
                "MediaUrl0": "https://api.twilio.com/media/img.jpg",
                "MediaContentType0": "image/jpeg",
            },
        )

    assert response.status_code == 200
    assert response.json() == {"reply": "Got your image!"}

    # Verify multimodal content was forwarded to OpenClaw (user message at index 1)
    call_args = mock_client.post.call_args
    content = call_args[1]["json"]["messages"][1]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "check this out"}
    assert content[1]["type"] == "image_url"
