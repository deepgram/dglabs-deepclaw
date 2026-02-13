"""Proxy router: receive forwarded Twilio SMS from deepclaw-control, route through OpenClaw, return JSON."""

import logging
from datetime import date

import httpx
from fastapi import APIRouter, Request

from app.config import get_settings
from app.services.mms_media import build_message_content
from app.services.sms_context import build_sms_messages

logger = logging.getLogger(__name__)

router = APIRouter(tags=["proxy"])

OPENCLAW_URL = "http://localhost:18789/v1/chat/completions"
FALLBACK_MESSAGE = "Hey! I'm just getting set up — text me again in a minute and I'll be ready to chat."


@router.post("/proxy/inbound-sms")
async def proxy_inbound_sms(request: Request):
    """Handle inbound SMS forwarded from deepclaw-control.

    Receives the raw Twilio form body, routes through OpenClaw,
    and returns JSON (not TwiML) for deepclaw-control to wrap.
    """
    form = await request.form()
    from_number = form.get("From", "")
    body = form.get("Body", "")
    message_sid = form.get("MessageSid", "")

    logger.info("Proxy inbound SMS: MessageSid=%s From=%s Body=%r", message_sid, from_number, body[:100])

    settings = get_settings()
    today = date.today().strftime("%Y%m%d")
    session_key = f"agent:{settings.OPENCLAW_AGENT_ID}:sms-{today}"

    content = await build_message_content(form)

    reply = FALLBACK_MESSAGE
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                OPENCLAW_URL,
                headers={
                    "Authorization": f"Bearer {settings.OPENCLAW_GATEWAY_TOKEN}",
                    "x-openclaw-session-key": session_key,
                },
                json={
                    "model": settings.AGENT_THINK_MODEL,
                    "messages": build_sms_messages(content),
                    "stream": False,
                },
                timeout=30.0,
            )
            resp.raise_for_status()
            data = resp.json()
            reply = data["choices"][0]["message"]["content"]
    except Exception:
        logger.exception("Failed to get response from OpenClaw")

    logger.info("Proxy SMS reply to %s: %s", from_number, reply[:200])

    return {"reply": reply}
