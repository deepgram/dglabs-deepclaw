"""SMS router: route inbound Twilio SMS through OpenClaw.

Delivery is coordinated by a shared ``_SMSSession`` object per day-session
(see ``app.services.sms_session``).  This handler is thin — it delegates
all delivery state management to the session.

Delivery paths:
- **Fast path (< 12s)**: TwiML reply from the SSE HTTP stream.
- **Slow path (> 12s)**: Safety-delayed task delivers via outbound SMS.
- **WS**: Only used for silence-detected intermediates and logging.
"""

import asyncio
import logging
from datetime import date
from xml.sax.saxutils import escape

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.config import get_settings
from app.services.mms_media import build_message_content
from app.services.sms_history import append_sms_entry
from app.services.sms_sender_registry import check_general_rate_limit, register_sender, was_recently_updated
from app.services.sms_context import (
    FALLBACK_MESSAGE,
    HOLDING_MESSAGE,
    TWILIO_REPLY_TIMEOUT,
    ask_openclaw,
    truncate_reply,
)
from app.services.sms_session import get_or_create_session

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sms"])


def _twiml(text: str) -> Response:
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Response><Message>{escape(text)}</Message></Response>"
    )
    return Response(content=body, media_type="application/xml")


def _empty_twiml() -> Response:
    """Return an empty TwiML response (no message sent)."""
    return Response(
        content='<?xml version="1.0" encoding="UTF-8"?><Response/>',
        media_type="application/xml",
    )


@router.post("/twilio/inbound-sms")
async def twilio_inbound_sms(request: Request):
    """Handle inbound Twilio SMS webhook. Routes through OpenClaw and replies."""
    form = await request.form()
    from_number = form.get("From", "")
    twilio_number = form.get("To", "")
    body = form.get("Body", "")
    message_sid = form.get("MessageSid", "")

    logger.info("Inbound SMS: MessageSid=%s From=%s Body=%r", message_sid, from_number, body[:100])

    settings = get_settings()
    today = date.today().strftime("%Y%m%d")
    session_key = f"agent:{settings.OPENCLAW_AGENT_ID}:sms-{today}"

    register_sender(session_key, from_number, twilio_number)

    content = await build_message_content(form)

    # Log inbound SMS to TEXTS.md for cross-channel context
    if body:
        append_sms_entry(settings, from_number, body)

    # Shared session — all concurrent requests see the same object
    session = get_or_create_session(session_key, from_number, twilio_number)

    # Subscribe WS (idempotent — same bound method, same key)
    from app.services.gateway_ws import get_gateway_ws

    gw = get_gateway_ws()
    if gw and gw.connected:
        await gw.subscribe(session_key, session.on_gateway_event)

    # Fire the agent request
    task = asyncio.create_task(ask_openclaw(settings, session_key, content))

    try:
        reply = await asyncio.wait_for(asyncio.shield(task), timeout=TWILIO_REPLY_TIMEOUT)
        reply = truncate_reply(reply)
        session.mark_twiml_replied()
        logger.info("SMS reply to %s: %s", from_number, reply[:200])
        return _twiml(reply)

    except asyncio.TimeoutError:
        session.start_safety_task(task)  # cancels old safety task
        if was_recently_updated(session_key):
            logger.info(
                "OpenClaw timed out for %s, intermediate already sent — no holding message",
                from_number,
            )
            return _empty_twiml()
        logger.info("OpenClaw timed out for %s, sending holding message", from_number)
        check_general_rate_limit(session_key)  # stamp rate limiter
        return _twiml(HOLDING_MESSAGE)

    except Exception:
        logger.exception("Failed to get response from OpenClaw")
        session.mark_error()
        return _twiml(FALLBACK_MESSAGE)
