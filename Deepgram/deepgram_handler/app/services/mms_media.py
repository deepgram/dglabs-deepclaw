"""MMS media helpers: extract Twilio media attachments and build OpenAI-compatible content."""

import base64
import logging

import httpx
from starlette.datastructures import FormData

logger = logging.getLogger(__name__)


async def build_message_content(form: FormData) -> str | list:
    """Build OpenAI chat message content from Twilio SMS/MMS form data.

    For plain text SMS, returns a string.
    For MMS with images, returns a multimodal content list with text and image_url parts.
    """
    body = form.get("Body", "") or ""
    num_media = int(form.get("NumMedia", 0))

    if num_media == 0:
        return body

    parts: list[dict] = []
    if body:
        parts.append({"type": "text", "text": body})

    async with httpx.AsyncClient(timeout=15.0) as client:
        for i in range(num_media):
            media_url = form.get(f"MediaUrl{i}", "")
            media_type = form.get(f"MediaContentType{i}", "")
            if not media_url:
                continue

            if media_type.startswith("image/"):
                try:
                    resp = await client.get(media_url)
                    resp.raise_for_status()
                    b64 = base64.b64encode(resp.content).decode("ascii")
                    data_uri = f"data:{media_type};base64,{b64}"
                    parts.append({"type": "image_url", "image_url": {"url": data_uri}})
                except Exception:
                    logger.exception("Failed to download media from %s", media_url)
                    parts.append({"type": "text", "text": f"[Failed to load image: {media_type}]"})
            else:
                parts.append({"type": "text", "text": f"[Unsupported media type: {media_type}]"})

    if not parts:
        return body if body else "[Empty message]"

    return parts
