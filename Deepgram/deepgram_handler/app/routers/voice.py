"""Voice call router: Twilio inbound/outbound webhooks and media stream WebSockets."""

import asyncio
import logging
from xml.sax.saxutils import escape

from fastapi import APIRouter, Request, WebSocket
from fastapi.responses import Response

from app.services.deepgram_agent import run_agent_bridge
from app.services.outbound_call import get_outbound_context
from app.services.twilio_media import parse_twilio_event

logger = logging.getLogger(__name__)

router = APIRouter(tags=["voice"])

OUTBOUND_CALL_PROMPT = (
    "You are an AI assistant making an outbound phone call on behalf of your user. "
    "Keep responses brief and conversational (1-2 sentences max). "
    "Speak naturally as if in a real phone conversation. "
    "IMPORTANT: Your responses will be spoken aloud via text-to-speech. Do NOT use any text formatting — "
    "no markdown, no bullet points, no asterisks, no numbered lists, no headers. "
    "Write plain conversational sentences only. "
    'Do NOT start your response with filler phrases like "Let me check" or "One moment" — '
    "jump straight into the answer."
)


@router.post("/twilio/inbound")
async def twilio_inbound(request: Request):
    """Handle inbound Twilio voice call. Returns TwiML to connect a media stream."""
    form = await request.form()
    call_sid = form.get("CallSid", "unknown")
    from_number = form.get("From", "")
    to_number = form.get("To", "")

    logger.info("Inbound call: CallSid=%s From=%s To=%s", call_sid, from_number, to_number)

    host = request.headers.get("host", "localhost")
    stream_url = f"wss://{host}/twilio/stream"

    twiml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        f'<Connect><Stream url="{stream_url}" /></Connect>'
        "</Response>"
    )
    return Response(content=twiml, media_type="application/xml")


@router.websocket("/twilio/stream")
async def twilio_stream(websocket: WebSocket):
    """Bidirectional Twilio media stream WebSocket.

    Waits for Twilio's 'start' event to get the stream_sid, then hands off
    to the Deepgram agent bridge for bidirectional audio relay.
    """
    await websocket.accept()
    logger.info("WS /twilio/stream: connection accepted")

    stream_sid = None

    # Buffer frames until we get the start event with stream_sid
    try:
        while stream_sid is None:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
            event = parse_twilio_event(raw)
            if event and event.get("event") == "start":
                stream_sid = event.get("start", {}).get("streamSid", "")
                logger.info("Stream started: streamSid=%s", stream_sid)
    except asyncio.TimeoutError:
        logger.error("Timed out waiting for stream start event")
        return
    except Exception:
        logger.exception("Error waiting for stream start")
        return

    if not stream_sid:
        logger.error("No streamSid received, closing")
        return

    await run_agent_bridge(websocket, stream_sid)
    logger.info("WS /twilio/stream: bridge finished")


# ---------------------------------------------------------------------------
# Outbound call handling
# ---------------------------------------------------------------------------


@router.post("/twilio/outbound")
async def twilio_outbound(request: Request, sid: str = ""):
    """TwiML webhook hit by Twilio when an outbound callee answers.

    Returns TwiML that connects the call to a media stream, passing the
    session_id as a custom parameter so the stream handler can look up
    the call's purpose.
    """
    logger.info("Outbound call answered: sid=%s", sid)

    host = request.headers.get("host", "localhost")
    stream_url = f"wss://{host}/twilio/outbound-stream"

    twiml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        "<Connect>"
        f'<Stream url="{stream_url}">'
        f'<Parameter name="session_id" value="{escape(sid)}" />'
        "</Stream>"
        "</Connect>"
        "</Response>"
    )
    return Response(content=twiml, media_type="application/xml")


@router.websocket("/twilio/outbound-stream")
async def twilio_outbound_stream(websocket: WebSocket):
    """Bidirectional media stream for outbound calls.

    Extracts the session_id from Twilio's custom parameters, retrieves the
    call purpose, and starts a Deepgram Voice Agent with a purpose-specific
    prompt and isolated session.
    """
    await websocket.accept()
    logger.info("WS /twilio/outbound-stream: connection accepted")

    stream_sid = None
    session_id = None

    try:
        while stream_sid is None:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
            event = parse_twilio_event(raw)
            if event and event.get("event") == "start":
                start_data = event.get("start", {})
                stream_sid = start_data.get("streamSid", "")
                custom = start_data.get("customParameters", {})
                session_id = custom.get("session_id", "")
                logger.info(
                    "Outbound stream started: streamSid=%s session_id=%s",
                    stream_sid,
                    session_id,
                )
    except asyncio.TimeoutError:
        logger.error("Timed out waiting for outbound stream start event")
        return
    except Exception:
        logger.exception("Error waiting for outbound stream start")
        return

    if not stream_sid:
        logger.error("No streamSid received for outbound stream, closing")
        return

    # Retrieve stored call context
    context = get_outbound_context(session_id) if session_id else None
    purpose = context.get("purpose", "") if context else ""

    if purpose:
        prompt = f"Your task for this call: {purpose}\n\n{OUTBOUND_CALL_PROMPT}"
    else:
        prompt = OUTBOUND_CALL_PROMPT

    await run_agent_bridge(
        websocket,
        stream_sid,
        call_id=session_id or None,
        prompt_override=prompt,
        greeting_override="Hello!",
    )
    logger.info("WS /twilio/outbound-stream: bridge finished")
