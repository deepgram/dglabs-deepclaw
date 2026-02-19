"""Actions router: endpoints for OpenClaw agent to send SMS and make calls."""

import json
import logging

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.config import get_settings
from app.services.outbound_call import make_call
from app.services.outbound_sms import send_sms
from app.services.sms_sender_registry import check_general_rate_limit, get_sender
from app.services.sms_session import notify_agent_sms
from app.services import session_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/actions", tags=["actions"])


class SendSmsRequest(BaseModel):
    to: str
    body: str
    from_number: str | None = None


class StatusUpdateRequest(BaseModel):
    message: str


class MakeCallRequest(BaseModel):
    to: str
    purpose: str
    from_number: str | None = None


@router.post("/send-sms")
async def action_send_sms(req: SendSmsRequest):
    """Send an outbound SMS. Called by the OpenClaw agent via curl."""
    settings = get_settings()
    logger.info(
        "Action send-sms: to=%s body_len=%d from=%s proxy_url=%s",
        req.to,
        len(req.body),
        req.from_number or "default",
        settings.TWILIO_PROXY_URL or "NOT SET",
    )
    try:
        result = await send_sms(to=req.to, text=req.body, from_number=req.from_number)
        notify_agent_sms(req.to)
        logger.info("Action send-sms: success to=%s result=%s", req.to, result)
        return {"ok": True, **result}
    except ValueError as e:
        logger.error("Action send-sms: config error: %s", e)
        return JSONResponse(status_code=503, content={"ok": False, "error": str(e)})
    except httpx.HTTPStatusError as e:
        logger.error(
            "Action send-sms: upstream error: status=%d url=%s body=%s",
            e.response.status_code,
            e.request.url,
            e.response.text[:300],
        )
        return JSONResponse(
            status_code=502,
            content={"ok": False, "error": f"Upstream returned {e.response.status_code}"},
        )
    except Exception:
        logger.exception("Action send-sms: unexpected error")
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "Internal error sending SMS"},
        )


@router.post("/status-update")
async def action_status_update(req: StatusUpdateRequest, request: Request):
    """Send a brief status update via SMS or voice injection.

    Checks SMS sender registry first (text sessions), then falls back to
    voice WebSocket injection (voice sessions).  Returns ``skipped`` for
    sessions that support neither channel (e.g. Control UI).
    """
    session_key = request.headers.get("x-openclaw-session-key", "")
    if not session_key:
        return {"ok": True, "skipped": True, "reason": "no_session_key"}

    # Rate limit (shared across SMS and voice)
    allowed, wait = check_general_rate_limit(session_key)
    if not allowed:
        logger.info(
            "Status-update rate-limited for %s (wait %.1fs)", session_key, wait,
        )
        return {"ok": True, "skipped": True, "reason": "rate_limited", "wait": wait}

    # --- SMS path ---
    phone, twilio_number = get_sender(session_key)
    if phone:
        try:
            await send_sms(to=phone, text=req.message, from_number=twilio_number)
            logger.info("Status-update SMS sent to %s: %s", phone, req.message[:100])
            return {"ok": True, "channel": "sms"}
        except Exception:
            logger.exception("Status-update SMS failed for %s", phone)
            return JSONResponse(
                status_code=502,
                content={"ok": False, "error": "Failed to send status update SMS"},
            )

    # --- Voice path ---
    dg_ws = session_registry.get_ws(session_key)
    if dg_ws:
        try:
            await dg_ws.send(json.dumps({
                "type": "InjectAgentMessage",
                "message": req.message,
            }))
            logger.info("Status-update voice injected for %s: %s", session_key, req.message[:100])
            return {"ok": True, "channel": "voice"}
        except Exception:
            logger.exception("Status-update voice injection failed for %s", session_key)
            return JSONResponse(
                status_code=502,
                content={"ok": False, "error": "Failed to inject voice status update"},
            )

    # --- No channel available (e.g. Control UI) ---
    return {"ok": True, "skipped": True, "reason": "no_channel"}


@router.post("/make-call")
async def action_make_call(req: MakeCallRequest):
    """Initiate an outbound phone call. Called by the OpenClaw agent via curl."""
    try:
        result = await make_call(to=req.to, purpose=req.purpose, from_number=req.from_number)
        return {"ok": True, **result}
    except ValueError as e:
        logger.error("Action make-call: config error: %s", e)
        return JSONResponse(status_code=503, content={"ok": False, "error": str(e)})
    except httpx.HTTPStatusError as e:
        logger.error(
            "Action make-call: upstream error: status=%d url=%s body=%s",
            e.response.status_code,
            e.request.url,
            e.response.text[:300],
        )
        return JSONResponse(
            status_code=502,
            content={"ok": False, "error": f"Upstream returned {e.response.status_code}"},
        )
    except Exception:
        logger.exception("Action make-call: unexpected error")
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "Internal error making call"},
        )
