"""Proxy router: receive forwarded Twilio SMS from deepclaw-control, route through OpenClaw, return JSON."""

import asyncio
import logging
from datetime import date

from fastapi import APIRouter, Request

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

router = APIRouter(tags=["proxy"])


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

    task = asyncio.create_task(ask_openclaw(settings, session_key, content))

    try:
        reply = await asyncio.wait_for(asyncio.shield(task), timeout=TWILIO_REPLY_TIMEOUT)
        reply = truncate_reply(reply)
        logger.info("Proxy SMS reply to %s: %s", from_number, reply[:200])
        return {"reply": reply}
    except asyncio.TimeoutError:
        logger.warning("OpenClaw timed out for %s, sending holding message", from_number)
        asyncio.create_task(send_delayed_reply(task, from_number))
        return {"reply": HOLDING_MESSAGE}
    except Exception:
        logger.exception("Failed to get response from OpenClaw")
        return {"reply": FALLBACK_MESSAGE}
