"""OpenClaw gateway JSON-RPC helper.

Provides a simple interface for extensions to call gateway methods
(sessions.list, agent, etc.) without constructing raw HTTP requests.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


async def call_gateway(
    method: str,
    params: dict[str, Any],
    gateway_url: str = "http://localhost:18789",
    gateway_token: str = "",
    timeout: float = 5.0,
) -> dict[str, Any] | None:
    """Call an OpenClaw gateway RPC method.

    Returns the ``result`` field from the response, or ``None`` on any error.
    """
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{gateway_url}/rpc",
                headers={"Authorization": f"Bearer {gateway_token}"},
                json={"method": method, "params": params},
            )
            if resp.status_code != 200:
                logger.warning(
                    "Gateway RPC %s returned %d: %s",
                    method,
                    resp.status_code,
                    resp.text[:200],
                )
            resp.raise_for_status()
            data = resp.json()
            return data.get("result")
    except Exception:
        logger.warning("Gateway RPC %s failed", method, exc_info=True)
        return None
