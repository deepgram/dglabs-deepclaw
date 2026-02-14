"""Outbound voice call service.

Supports two modes:
1. **Control plane proxy** — when ``TWILIO_PROXY_URL`` is set, POSTs to the
   deepclaw-control proxy at ``{TWILIO_PROXY_URL}/api/voice/call``.
2. **Direct Twilio API** — when ``TWILIO_PROXY_URL`` is empty, calls the
   Twilio REST API directly using ``TWILIO_ACCOUNT_SID``,
   ``TWILIO_AUTH_TOKEN``, and ``TWILIO_FROM_NUMBER``.

In both cases, the callback URL points back to this instance's
``/twilio/outbound?sid={session_id}`` endpoint so the Deepgram Voice Agent
session can be configured when the callee answers.
"""

import logging
import uuid

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

# In-memory store for outbound call context, keyed by session_id.
# Populated when a call is initiated, consumed when the callee answers.
_outbound_calls: dict[str, dict] = {}


async def make_call(
    to: str,
    purpose: str = "",
) -> dict:
    """Initiate an outbound voice call.

    Parameters
    ----------
    to:
        E.164 destination phone number.
    purpose:
        Brief description of the call's purpose.  Becomes the outbound
        agent's prompt instructions.

    Returns
    -------
    dict
        JSON response with ``session_id`` included.

    Raises
    ------
    ValueError
        If neither proxy nor direct Twilio credentials are configured.
    httpx.HTTPStatusError
        On non-2xx responses from the upstream API.
    """
    settings = get_settings()
    proxy_url = settings.TWILIO_PROXY_URL

    session_id = f"outbound-{uuid.uuid4().hex[:12]}"
    callback_url = f"{settings.PUBLIC_URL}/twilio/outbound?sid={session_id}"

    # Store context for the outbound webhook to use when callee answers
    _outbound_calls[session_id] = {"purpose": purpose, "to": to}

    try:
        if proxy_url:
            result = await _call_via_proxy(proxy_url, to, callback_url)
        else:
            result = await _call_via_twilio(settings, to, callback_url)

        result["session_id"] = session_id
        return result
    except Exception:
        # Clean up stored context on failure
        _outbound_calls.pop(session_id, None)
        raise


async def _call_via_proxy(
    proxy_url: str,
    to: str,
    callback_url: str,
) -> dict:
    """Initiate call through the deepclaw-control proxy."""
    url = f"{proxy_url}/api/voice/call"

    logger.info(
        "Outbound call (proxy): POST %s to=%s callback=%s",
        url, to, callback_url,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json={"to": to, "url": callback_url})
        logger.info(
            "Outbound call (proxy): response status=%d body=%s",
            resp.status_code, resp.text[:300],
        )
        resp.raise_for_status()
        return resp.json()


async def _call_via_twilio(
    settings,
    to: str,
    callback_url: str,
) -> dict:
    """Initiate call directly via the Twilio REST API."""
    if not settings.TWILIO_ACCOUNT_SID or not settings.TWILIO_AUTH_TOKEN:
        raise ValueError(
            "Neither TWILIO_PROXY_URL nor direct Twilio credentials "
            "(TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN) are configured."
        )

    sender = settings.TWILIO_FROM_NUMBER
    if not sender:
        raise ValueError(
            "No sender number: set TWILIO_FROM_NUMBER for direct Twilio calls."
        )

    url = (
        f"https://api.twilio.com/2010-04-01"
        f"/Accounts/{settings.TWILIO_ACCOUNT_SID}/Calls.json"
    )

    logger.info(
        "Outbound call (direct): POST %s to=%s from=%s callback=%s",
        url, to, sender, callback_url,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            data={"To": to, "From": sender, "Url": callback_url},
            auth=(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN),
        )
        logger.info(
            "Outbound call (direct): response status=%d body=%s",
            resp.status_code, resp.text[:300],
        )
        resp.raise_for_status()
        return resp.json()


def get_outbound_context(session_id: str) -> dict | None:
    """Pop and return the stored context for an outbound call.

    Returns ``None`` if the session_id is unknown (e.g. already consumed
    or the process restarted).
    """
    return _outbound_calls.pop(session_id, None)
