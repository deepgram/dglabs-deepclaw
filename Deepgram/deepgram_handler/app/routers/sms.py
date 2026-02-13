"""SMS router: route inbound Twilio SMS through OpenClaw."""

import asyncio
import logging
from datetime import date
from xml.sax.saxutils import escape

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.config import get_settings
from app.services.mms_media import build_message_content
from app.services.sms_context import (
    FALLBACK_MESSAGE,
    HOLDING_MESSAGE,
    TWILIO_REPLY_TIMEOUT,
    ask_openclaw,
    send_delayed_reply,
    truncate_reply,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sms"])


def _twiml(text: str) -> Response:
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Response><Message>{escape(text)}</Message></Response>"
    )
    return Response(content=body, media_type="application/xml")


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

    task = asyncio.create_task(ask_openclaw(settings, session_key, content))

    try:
        reply = await asyncio.wait_for(asyncio.shield(task), timeout=TWILIO_REPLY_TIMEOUT)
        reply = truncate_reply(reply)
        logger.info("SMS reply to %s: %s", from_number, reply[:200])
        return _twiml(reply)
    except asyncio.TimeoutError:
        logger.warning("OpenClaw timed out for %s, sending holding message", from_number)
        asyncio.create_task(send_delayed_reply(task, from_number))
        return _twiml(HOLDING_MESSAGE)
    except Exception:
        logger.exception("Failed to get response from OpenClaw")
        return _twiml(FALLBACK_MESSAGE)
