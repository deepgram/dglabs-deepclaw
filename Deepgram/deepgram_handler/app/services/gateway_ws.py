"""Persistent WebSocket client for the OpenClaw gateway event stream.

Maintains a long-lived connection, subscribes to session-scoped events
(agent, chat), and routes them to per-session callbacks.  Used by the
SMS router to receive real-time agent progress (tool calls, intermediate
text, final replies) and forward them as SMS messages.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Awaitable, Callable

import websockets

logger = logging.getLogger(__name__)

GATEWAY_WS_URL = "ws://localhost:18789"

EventCallback = Callable[[str, dict[str, Any]], Awaitable[None] | None]


class GatewayWSClient:
    """Long-lived WebSocket connection to the OpenClaw gateway."""

    def __init__(self, token: str) -> None:
        self.token = token
        self.ws: Any = None
        self._subscriptions: dict[str, EventCallback] = {}
        self._connected = asyncio.Event()
        self._closed = False

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    async def start(self) -> None:
        """Kick off the connection loop (runs in background)."""
        asyncio.create_task(self._connect_loop())

    async def _connect_loop(self) -> None:
        backoff = 2.0
        attempts = 0
        while not self._closed:
            try:
                await self._connect()
                backoff = 2.0
                attempts = 0
                await self._listen()
            except asyncio.CancelledError:
                return
            except Exception:
                self._connected.clear()
                attempts += 1
                if attempts <= 3:
                    # Quiet during startup — gateway may still be initializing
                    logger.info(
                        "[gateway-ws] gateway not ready, retrying in %.0fs (attempt %d)",
                        backoff,
                        attempts,
                    )
                else:
                    logger.warning(
                        "[gateway-ws] connection lost, reconnecting in %.0fs",
                        backoff,
                        exc_info=True,
                    )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _connect(self) -> None:
        self.ws = await websockets.connect(
            GATEWAY_WS_URL, max_size=25 * 1024 * 1024
        )
        connect_id = str(uuid.uuid4())
        await self.ws.send(
            json.dumps(
                {
                    "type": "req",
                    "id": connect_id,
                    "method": "connect",
                    "params": {
                        "minProtocol": 1,
                        "maxProtocol": 100,
                        "client": {
                            "id": "node-host",
                            "version": "1.0",
                            "platform": "python",
                            "mode": "node",
                        },
                        "auth": {"token": self.token} if self.token else None,
                        "role": "node",
                        "scopes": [],
                    },
                }
            )
        )

        # Wait for hello-ok (skip events like connect.challenge, tick)
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=10)
            msg = json.loads(raw)
            if msg.get("type") == "event":
                continue
            if msg.get("type") == "res" and msg.get("id") == connect_id:
                if not msg.get("ok"):
                    error_msg = msg.get("error", {}).get("message", "unknown")
                    raise RuntimeError(f"Gateway connect failed: {error_msg}")
                logger.info("[gateway-ws] connected to gateway")
                self._connected.set()
                # Re-subscribe to any active sessions after reconnect
                for sk in list(self._subscriptions):
                    await self._send_subscribe(sk)
                return

    async def _listen(self) -> None:
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") != "event":
                continue

            event_name = msg.get("event", "")
            payload = msg.get("payload")
            if not isinstance(payload, dict):
                continue

            session_key = payload.get("sessionKey")
            cb = self._subscriptions.get(session_key) if session_key else None

            # Log subscribed events — demote noisy token-level assistant
            # streaming events to DEBUG, keep everything else at INFO
            if cb and session_key:
                state = payload.get("state", "")
                stream = payload.get("stream", "")
                data = payload.get("data", {})
                phase = data.get("phase", "") if isinstance(data, dict) else ""
                name = data.get("name", "") if isinstance(data, dict) else ""
                is_noisy = (
                    (event_name == "agent" and stream == "assistant" and not phase)
                    or (event_name == "chat" and state == "delta")
                )
                log = logger.debug if is_noisy else logger.info
                log(
                    "[gateway-ws] event: %s state=%s stream=%s phase=%s name=%s session=%s",
                    event_name, state, stream, phase, name, session_key[-12:],
                )

            if not cb:
                continue

            try:
                result = cb(event_name, payload)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.warning(
                    "[gateway-ws] callback error for %s", session_key, exc_info=True
                )

    # -- subscription management ------------------------------------------

    async def subscribe(self, session_key: str, callback: EventCallback) -> None:
        """Subscribe to events for *session_key*.

        If already subscribed, updates the callback without re-subscribing
        on the gateway side (which would cause duplicate event delivery).
        """
        already_subscribed = session_key in self._subscriptions
        self._subscriptions[session_key] = callback
        if self.connected and not already_subscribed:
            await self._send_subscribe(session_key)

    async def unsubscribe(self, session_key: str) -> None:
        """Unsubscribe from *session_key* events."""
        self._subscriptions.pop(session_key, None)
        if self.connected:
            try:
                await self._send_unsubscribe(session_key)
            except Exception:
                logger.debug("[gateway-ws] unsubscribe send failed (connection may be closed)")

    async def _send_subscribe(self, session_key: str) -> None:
        req_id = str(uuid.uuid4())
        await self.ws.send(
            json.dumps(
                {
                    "type": "req",
                    "id": req_id,
                    "method": "node.event",
                    "params": {
                        "event": "chat.subscribe",
                        "payloadJSON": json.dumps({"sessionKey": session_key}),
                    },
                }
            )
        )
        logger.info("[gateway-ws] subscribed to %s", session_key)

    async def _send_unsubscribe(self, session_key: str) -> None:
        req_id = str(uuid.uuid4())
        await self.ws.send(
            json.dumps(
                {
                    "type": "req",
                    "id": req_id,
                    "method": "node.event",
                    "params": {
                        "event": "chat.unsubscribe",
                        "payloadJSON": json.dumps({"sessionKey": session_key}),
                    },
                }
            )
        )
        logger.info("[gateway-ws] unsubscribed from %s", session_key)

    def stop(self) -> None:
        self._closed = True
        if self.ws:
            asyncio.create_task(self.ws.close())


# -- module-level singleton -----------------------------------------------

_client: GatewayWSClient | None = None


def get_gateway_ws() -> GatewayWSClient | None:
    """Return the singleton gateway WS client (``None`` before init)."""
    return _client


async def init_gateway_ws(token: str) -> GatewayWSClient:
    """Create and start the singleton gateway WS client."""
    global _client
    _client = GatewayWSClient(token)
    await _client.start()
    return _client
