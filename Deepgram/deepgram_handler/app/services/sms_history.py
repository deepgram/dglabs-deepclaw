"""SMS history — appends inbound text messages to TEXTS.md.

Logs each inbound SMS with a timestamp and phone number so the voice
prompt can include recent texts as cross-channel context.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.services.workspace import (
    read_workspace_file,
    workspace_path,
    write_workspace_file,
)

logger = logging.getLogger(__name__)

TEXTS_HEADER = "# Text Messages\n"
MAX_TEXT_ENTRIES = 50


def _format_timestamp(tz_name: str) -> str:
    """Format current time for TEXTS.md entry heading."""
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(tz_name)
    except (ImportError, KeyError):
        tz = timezone.utc

    dt = datetime.now(tz)
    return dt.strftime("%m/%d/%Y, %-I:%M %p")


def _trim_entries(content: str, max_entries: int) -> str:
    """Keep the header and the last N entries."""
    import re

    parts = re.split(r"(?=^### )", content, flags=re.MULTILINE)
    header = parts[0] if parts else TEXTS_HEADER
    entries = parts[1:]

    if len(entries) <= max_entries:
        return content

    kept = entries[-max_entries:]
    return header.rstrip() + "\n\n" + "".join(kept).rstrip() + "\n"


def append_sms_entry(settings, from_number: str, body: str) -> None:
    """Append an inbound SMS entry to TEXTS.md."""
    try:
        texts_path = workspace_path(settings, "TEXTS.md")
        existing = read_workspace_file(texts_path) or TEXTS_HEADER

        timestamp = _format_timestamp(settings.TIMEZONE)
        entry = f"### {timestamp} -- {from_number} (sms)\n{body}\n"
        updated = existing.rstrip() + "\n\n" + entry

        trimmed = _trim_entries(updated, MAX_TEXT_ENTRIES)
        write_workspace_file(texts_path, trimmed)

        logger.info("[sms-history] Logged inbound SMS from %s", from_number)

    except Exception:
        logger.exception("[sms-history] Failed to log SMS entry")
