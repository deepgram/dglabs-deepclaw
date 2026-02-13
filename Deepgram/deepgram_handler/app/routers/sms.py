"""SMS router: route inbound Twilio SMS through OpenClaw."""

import logging
from datetime import date
from xml.sax.saxutils import escape

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.config import get_settings
from app.services.mms_media import build_message_content

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sms"])

OPENCLAW_URL = "http://localhost:18789/v1/chat/completions"
FALLBACK_MESSAGE = "Sorry, I'm having trouble right now. Please try again later."


@router.post("/twilio/inbound-sms")
async def twilio_inbound_sms(request: Request):
    """Handle inbound Twilio SMS webhook. Routes through OpenClaw and replies."""
    form = await request.form()
    from_number = form.get("From", "")
    body = form.get("Body", "")
    message_sid = form.get("MessageSid", "")

    logger.info("Inbound SMS: MessageSid=%s From=%s Body=%r", message_sid, from_number, body[:100])

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
                    "messages": [{"role": "user", "content": content}],
                    "stream": False,
                },
                timeout=30.0,
            )
            resp.raise_for_status()
            data = resp.json()
            reply = data["choices"][0]["message"]["content"]
    except Exception:
        logger.exception("Failed to get response from OpenClaw")

    logger.info("SMS reply to %s: %s", from_number, reply[:200])

    twiml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Response><Message>{escape(reply)}</Message></Response>"
    )
    logger.debug("TwiML response: %s", twiml)
    return Response(content=twiml, media_type="application/xml")
