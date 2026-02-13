"""OpenClaw gateway WebSocket RPC helper.

The gateway exposes methods (sessions.list, agent, etc.) over a WebSocket
protocol, not HTTP.  Each call opens a short-lived WebSocket connection,
performs the JSON-RPC handshake, executes the request, and disconnects.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

import websockets

logger = logging.getLogger(__name__)


async def call_gateway(
    method: str,
    params: dict[str, Any],
    gateway_url: str = "ws://localhost:18789",
    gateway_token: str = "",
    timeout: float = 5.0,
) -> dict[str, Any] | None:
    """Call an OpenClaw gateway RPC method via WebSocket.

    Opens a WebSocket, performs the connect handshake with token auth,
    sends the request, waits for the response, and closes.

    Returns the ``payload`` field from the response, or ``None`` on any error.
    """
    try:
        logger.info("Gateway RPC %s — connecting to %s", method, gateway_url)
        async with asyncio.timeout(timeout):
            async with websockets.connect(gateway_url) as ws:
                # --- connect handshake ---
                connect_id = str(uuid.uuid4())
                await ws.send(
                    json.dumps(
                        {
                            "type": "req",
                            "id": connect_id,
                            "method": "connect",
                            "params": {
                                "minProtocol": 1,
                                "maxProtocol": 100,
                                "client": {
                                    "id": "gateway-client",
                                    "version": "1.0",
                                    "platform": "python",
                                    "mode": "backend",
                                },
                                "auth": (
                                    {"token": gateway_token}
                                    if gateway_token
                                    else None
                                ),
                                "role": "operator",
                                "scopes": ["operator.write"],
                            },
                        }
                    )
                )

                # Wait for hello-ok response (skip events like connect.challenge)
                while True:
                    raw = await ws.recv()
                    msg = json.loads(raw)
                    if msg.get("type") == "event":
                        logger.debug("Gateway WS event during handshake: %s", msg.get("event"))
                        continue
                    if msg.get("type") == "res" and msg.get("id") == connect_id:
                        if not msg.get("ok"):
                            error = msg.get("error", {})
                            logger.warning(
                                "Gateway connect failed: %s",
                                error.get("message", "unknown"),
                            )
                            return None
                        logger.info("Gateway RPC %s — connected", method)
                        break

                # --- method request ---
                req_id = str(uuid.uuid4())
                await ws.send(
                    json.dumps(
                        {
                            "type": "req",
                            "id": req_id,
                            "method": method,
                            "params": params,
                        }
                    )
                )

                # Wait for method response (skip events)
                while True:
                    raw = await ws.recv()
                    msg = json.loads(raw)
                    if msg.get("type") == "event":
                        logger.debug("Gateway WS event during RPC: %s", msg.get("event"))
                        continue
                    if msg.get("type") == "res" and msg.get("id") == req_id:
                        if not msg.get("ok"):
                            error = msg.get("error", {})
                            logger.warning(
                                "Gateway RPC %s failed: %s",
                                method,
                                error.get("message", "unknown"),
                            )
                            return None
                        logger.info("Gateway RPC %s — success", method)
                        return msg.get("payload")

    except Exception:
        logger.warning("Gateway RPC %s failed", method, exc_info=True)
        return None
