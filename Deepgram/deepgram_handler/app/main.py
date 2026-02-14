"""Twilio Proxy - FastAPI application."""

import logging
import socket
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routers import actions, openclaw_proxy, proxy, sms, voice

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
)

app = FastAPI(title="Twilio Proxy", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(actions.router)
app.include_router(openclaw_proxy.router)
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
