"""Twilio Proxy - FastAPI application."""

import logging
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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


@app.get("/health")
async def health():
    return {"status": "ok"}
