"""Outbound SMS service via deepclaw-control proxy.

When sharpclaw is managed by deepclaw-control, the control plane injects
``TWILIO_PROXY_URL`` at provisioning time.  This module POSTs outbound
messages to ``{TWILIO_PROXY_URL}/api/sms/send`` so the control plane can
handle the actual Twilio API call.
"""

import logging

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)


async def send_sms(
    to: str,
    text: str | None = None,
    from_number: str | None = None,
    media_urls: list[str] | None = None,
) -> dict:
    """Send an outbound SMS through the deepclaw-control proxy.

    Parameters
    ----------
    to:
        E.164 destination phone number.
    text:
        Message body (optional when *media_urls* is provided).
    from_number:
        E.164 sender number.  When ``None`` the control plane picks a default.
    media_urls:
        Optional list of publicly-reachable media URLs to attach as MMS.

    Returns
    -------
    dict
        JSON response from the control plane, typically ``{"sid": ..., "status": ...}``.

    Raises
    ------
    ValueError
        If ``TWILIO_PROXY_URL`` is empty or not configured.
    httpx.HTTPStatusError
        If the control plane returns a non-2xx status code.
    """
    settings = get_settings()
    proxy_url = settings.TWILIO_PROXY_URL

    if not proxy_url:
        raise ValueError(
            "TWILIO_PROXY_URL is not configured. "
            "Set the environment variable to the deepclaw-control base URL."
        )

    url = f"{proxy_url}/api/sms/send"
    payload: dict = {"to": to, "text": text, "from": from_number}
    if media_urls is not None:
        payload["mediaUrls"] = media_urls

    logger.info(
        "Outbound SMS: POST %s to=%s text_len=%d from=%s",
        url, to, len(text or ""), from_number or "default",
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload)
        logger.info(
            "Outbound SMS: response status=%d body=%s",
            resp.status_code, resp.text[:300],
        )
        resp.raise_for_status()
        return resp.json()
