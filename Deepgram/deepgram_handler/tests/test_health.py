from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def test_health_gateway_alive(client):
    with patch("app.main._gateway_alive", return_value=True):
        resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["gateway"] == "connected"


async def test_health_gateway_down(client):
    with patch("app.main._gateway_alive", return_value=False):
        resp = await client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["gateway"] == "unreachable"
