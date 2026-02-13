"""Parsers for workspace markdown files (USER.md, CALLS.md, IDENTITY.md).

Extracts structured data from the markdown templates used by OpenClaw agents.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, fields


@dataclass
class UserProfile:
    """Structured user data extracted from USER.md."""

    name: str = ""
    call_name: str = ""
    pronouns: str = ""
    timezone: str = ""
    notes: str = ""
    context: str = ""


# Patterns that indicate a field is still a placeholder (not filled in).
_PLACEHOLDER_RE = re.compile(r"^_?\(?.*?\)?_?$")
_KNOWN_PLACEHOLDERS = {
    "optional",
    "what do they care about? what projects are they working on? what annoys them? what makes them laugh? build this over time.",
}

# Maps USER.md field labels (lowercased) to UserProfile attribute names.
_FIELD_MAP: dict[str, str] = {
    "name": "name",
    "what to call them": "call_name",
    "pronouns": "pronouns",
    "timezone": "timezone",
    "notes": "notes",
}


def _is_placeholder(value: str) -> bool:
    """Return True if *value* is an unfilled placeholder."""
    value = value.strip()
    if not value:
        return True
    # Strip outer markdown formatting
    normalized = re.sub(r"^[*_]+|[*_]+$", "", value).strip()
    if normalized.startswith("(") and normalized.endswith(")"):
        normalized = normalized[1:-1].strip()
    if normalized.lower() in _KNOWN_PLACEHOLDERS:
        return True
    # Match pattern like _(optional)_ or _(pick something you like)_
    if re.match(r"^_\(.*\)_$", value):
        return True
    return False


def parse_user_markdown(content: str) -> UserProfile:
    """Parse ``USER.md`` content into a :class:`UserProfile`.

    Extracts ``- **Label:** value`` patterns for known fields and the
    ``## Context`` free-text section.  The colon is inside the bold markers
    (e.g. ``**Name:**``).
    """
    profile = UserProfile()
    lines = content.split("\n")

    # Find context section
    context_start = -1
    for i, line in enumerate(lines):
        if re.match(r"^##\s+context", line.strip(), re.IGNORECASE):
            context_start = i + 1
            break

    # Parse key-value lines before context section
    kv_end = context_start - 1 if context_start != -1 else len(lines)
    for i in range(kv_end):
        cleaned = lines[i].strip().lstrip("- ")
        colon_idx = cleaned.find(":")
        if colon_idx == -1:
            continue
        # Strip bold/italic markers from the label
        label = re.sub(r"[*_]", "", cleaned[:colon_idx]).strip().lower()
        # Strip trailing bold/italic markers from the value
        value = re.sub(r"^[*_]+|[*_]+$", "", cleaned[colon_idx + 1 :]).strip()
        if not value or _is_placeholder(value):
            continue
        attr = _FIELD_MAP.get(label)
        if attr:
            setattr(profile, attr, value)

    # Extract ## Context section (everything after heading until --- or next heading)
    if context_start != -1:
        ctx_lines = []
        for i in range(context_start, len(lines)):
            line = lines[i]
            if re.match(r"^---\s*$", line) or re.match(r"^#\s", line):
                break
            ctx_lines.append(line)
        ctx = "\n".join(ctx_lines).strip()
        if ctx and not _is_placeholder(ctx):
            profile.context = ctx

    return profile


def has_values(profile: UserProfile) -> bool:
    """Return ``True`` if any field in *profile* is non-empty."""
    return any(getattr(profile, f.name) for f in fields(profile))


def parse_calls_md(content: str, count: int = 3) -> list[str]:
    """Parse ``CALLS.md`` and return the last *count* call summaries.

    Each call entry starts with a ``### `` heading.  Returns a list of
    strings formatted as ``heading + truncated body`` (max 150 chars each).
    """
    if not content or not content.strip():
        return []

    # Split on ### headings, keeping the heading text
    entries: list[str] = []
    for block in re.split(r"(?=^### )", content, flags=re.MULTILINE):
        block = block.strip()
        if not block.startswith("### "):
            continue
        # Extract heading and body
        lines = block.split("\n", 1)
        heading = lines[0].strip()
        body = lines[1].strip() if len(lines) > 1 else ""
        if body and len(body) > 150:
            body = body[:147] + "..."
        summary = f"{heading}\n{body}" if body else heading
        entries.append(summary)

    # Return last N
    return entries[-count:] if entries else []


def is_blank_identity(content: str) -> bool:
    """Return ``True`` if ``IDENTITY.md`` has no real name filled in.

    Checks the ``- **Name:** value`` field — if value is empty or a
    placeholder, the identity is considered blank.
    """
    if not content or not content.strip():
        return True

    lines = content.split("\n")
    for i, line in enumerate(lines):
        cleaned = line.strip().lstrip("- ")
        colon_idx = cleaned.find(":")
        if colon_idx == -1:
            continue
        label = re.sub(r"[*_]", "", cleaned[:colon_idx]).strip().lower()
        if label != "name":
            continue
        # Found the Name field
        value = re.sub(r"^[*_]+|[*_]+$", "", cleaned[colon_idx + 1 :]).strip()
        if value and not _is_placeholder(value):
            return False
        # Value is empty — check indented next line for placeholder
        if not value and i + 1 < len(lines):
            next_val = lines[i + 1].strip()
            if next_val and not _is_placeholder(next_val):
                return False
        return True

    # No Name field found at all
    return True
