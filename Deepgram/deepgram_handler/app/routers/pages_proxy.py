"""Reverse proxy for page-builder pages served by the OpenClaw gateway."""

import logging

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

logger = logging.getLogger(__name__)

router = APIRouter(tags=["pages-proxy"])

OPENCLAW_BASE = "http://localhost:18789"


@router.get("/pages/{page_id:path}")
async def proxy_page(page_id: str, request: Request):
    """Proxy GET /pages/* to the OpenClaw gateway's page-builder handler."""
    url = f"{OPENCLAW_BASE}/pages/{page_id}"
    if request.url.query:
        url = f"{url}?{request.url.query}"

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
    except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
        logger.warning("Gateway unreachable for %s", url)
        return JSONResponse(
            status_code=502,
            content={"detail": "Gateway unavailable"},
        )

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers={
            k: v
            for k, v in resp.headers.items()
            if k.lower() not in ("transfer-encoding", "content-encoding")
        },
    )
