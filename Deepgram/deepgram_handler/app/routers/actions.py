"""Actions router: endpoints for OpenClaw agent to send SMS and make calls."""

import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

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


@router.post("/send-sms")
async def action_send_sms(req: SendSmsRequest):
    """Send an outbound SMS. Called by the OpenClaw agent via curl."""
    try:
        result = await send_sms(to=req.to, text=req.body, from_number=req.from_number)
        return {"ok": True, **result}
    except ValueError as e:
        logger.error("SMS config error: %s", e)
        return JSONResponse(status_code=503, content={"ok": False, "error": str(e)})
    except httpx.HTTPStatusError as e:
        logger.error("SMS control plane error: %s", e)
        return JSONResponse(
            status_code=502,
            content={"ok": False, "error": f"Control plane returned {e.response.status_code}"},
        )
    except Exception:
        logger.exception("Unexpected error sending SMS")
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "Internal error sending SMS"},
        )


@router.post("/make-call")
async def action_make_call(req: MakeCallRequest):
    """Initiate an outbound phone call. Called by the OpenClaw agent via curl."""
    try:
        result = await make_call(to=req.to, purpose=req.purpose)
        return {"ok": True, **result}
    except ValueError as e:
        logger.error("Call config error: %s", e)
        return JSONResponse(status_code=503, content={"ok": False, "error": str(e)})
    except httpx.HTTPStatusError as e:
        logger.error("Call control plane error: %s", e)
        return JSONResponse(
            status_code=502,
            content={"ok": False, "error": f"Control plane returned {e.response.status_code}"},
        )
    except Exception:
        logger.exception("Unexpected error making call")
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "Internal error making call"},
        )
