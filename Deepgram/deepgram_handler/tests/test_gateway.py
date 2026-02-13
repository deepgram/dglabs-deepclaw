"""Tests for OpenClaw gateway RPC helper."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.gateway import call_gateway


@pytest.mark.asyncio
async def test_call_gateway_sends_rpc():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"result": {"sessions": []}}
    mock_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.services.gateway.httpx.AsyncClient", return_value=mock_client):
        result = await call_gateway(
            method="sessions.list",
            params={"spawnedBy": "agent:main:abc"},
            gateway_url="http://localhost:18789",
            gateway_token="test-token",
        )

    assert result == {"sessions": []}
    mock_client.post.assert_called_once()
    call_kwargs = mock_client.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert body["method"] == "sessions.list"
    assert body["params"]["spawnedBy"] == "agent:main:abc"


@pytest.mark.asyncio
async def test_call_gateway_returns_none_on_error():
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(side_effect=Exception("connection refused"))
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.services.gateway.httpx.AsyncClient", return_value=mock_client):
        result = await call_gateway(
            method="sessions.list",
            params={},
            gateway_url="http://localhost:18789",
            gateway_token="test-token",
        )

    assert result is None


@pytest.mark.asyncio
async def test_call_gateway_sends_auth_header():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"result": {}}
    mock_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.services.gateway.httpx.AsyncClient", return_value=mock_client):
        await call_gateway(
            method="agent",
            params={"message": "Call ended", "sessionKey": "child:123"},
            gateway_url="http://localhost:18789",
            gateway_token="my-secret-token",
        )

    call_kwargs = mock_client.post.call_args
    headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
    assert headers["Authorization"] == "Bearer my-secret-token"
