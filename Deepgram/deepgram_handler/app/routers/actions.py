"""Actions router: endpoints for OpenClaw agent to send SMS and make calls."""

import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.config import get_settings
from app.services.outbound_call import make_call
from app.services.outbound_sms import send_sms

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/actions", tags=["actions"])


class SendSmsRequest(BaseModel):
    to: str
    body: str
    from_number: str | None = None


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
