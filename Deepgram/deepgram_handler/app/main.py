"""Twilio Proxy - FastAPI application."""

import logging
import socket
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routers import actions, openclaw_proxy, pages_proxy, proxy, sms, voice

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
)
logging.getLogger("httpx").setLevel(logging.WARNING)


class _PageVersionFilter(logging.Filter):
    """Drop noisy 200 OK logs from page-builder version polling."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "/pages/" in msg and "/version" in msg and " 200 " in msg:
            return False
        return True


logging.getLogger("uvicorn.access").addFilter(_PageVersionFilter())


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Connect the persistent gateway WebSocket client for SMS event streaming."""
    from app.config import get_settings
    from app.services.gateway_ws import init_gateway_ws

    try:
        settings = get_settings()
        await init_gateway_ws(settings.OPENCLAW_GATEWAY_TOKEN)
    except Exception:
        logging.getLogger(__name__).warning(
            "Gateway WS client failed to start (SMS intermediates disabled)",
            exc_info=True,
        )
    yield


app = FastAPI(title="Twilio Proxy", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(actions.router)
app.include_router(openclaw_proxy.router)
app.include_router(pages_proxy.router)
app.include_router(proxy.router)
app.include_router(sms.router)
app.include_router(voice.router)

GATEWAY_HOST = "127.0.0.1"
GATEWAY_PORT = 18789


def _gateway_alive() -> bool:
    """TCP connect to the gateway. Returns True if reachable."""
    try:
        s = socket.create_connection((GATEWAY_HOST, GATEWAY_PORT), timeout=2)
        s.close()
        return True
    except OSError:
        return False


@app.get("/health")
async def health():
    if _gateway_alive():
        return {"status": "ok", "gateway": "connected"}
    return JSONResponse(
        status_code=503,
        content={"status": "degraded", "gateway": "unreachable"},
    )
