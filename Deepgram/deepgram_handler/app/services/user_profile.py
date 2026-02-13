"""Post-call user profile extraction -- merges into USER.md.

After each inbound call, extracts user profile fields from the transcript
via Claude Sonnet and merges them into the agent's USER.md with fill-only
semantics (never overwrites existing values).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from app.services.workspace import (
    CallInfo,
    call_anthropic,
    format_transcript,
    parse_json_response,
    read_workspace_file,
    workspace_path,
    write_workspace_file,
)

logger = logging.getLogger(__name__)

USER_PLACEHOLDERS = {
    "optional",
    "what do they care about? what projects are they working on? what annoys them? what makes them laugh? build this over time.",
}

PROFILE_SYSTEM_PROMPT = (
    "Extract user profile information from this phone call transcript. "
    "Return ONLY a JSON object with the fields you can confidently extract. "
    "Do NOT guess or infer values not in the conversation. Return valid JSON only."
)

PROFILE_PROMPT_TEMPLATE = (
    "Extract user profile information from this phone call transcript.\n"
    "Return ONLY a JSON object with fields you can confidently extract from the conversation.\n\n"
    "Fields:\n"
    '- "name": Their full name if stated\n'
    '- "callName": What they prefer to be called (first name, nickname -- whatever they used)\n'
    '- "pronouns": If mentioned or clearly implied\n'
    '- "timezone": Only if explicitly stated or strongly implied by context\n'
    '- "notes": Quick facts worth remembering (job, family members mentioned, preferences)\n'
    '- "context": What they care about -- projects, interests, what they called about (1-2 sentences)\n\n'
    "Only include fields supported by clear evidence in the transcript.\n"
    "Do NOT guess or infer values not in the conversation.\n"
    "Return valid JSON only, no markdown.\n\n"
    "Transcript:\n{transcript}"
)


@dataclass
class UserProfile:
    name: str | None = None
    call_name: str | None = None
    pronouns: str | None = None
    timezone: str | None = None
    notes: str | None = None
    context: str | None = None


def normalize_value(value: str) -> str:
    """Normalize a value for placeholder comparison."""
    n = value.strip()
    n = re.sub(r"^[*_]+|[*_]+$", "", n).strip()
    if n.startswith("(") and n.endswith(")"):
        n = n[1:-1].strip()
    n = n.replace("\u2013", "-").replace("\u2014", "-")
    n = re.sub(r"\s+", " ", n).lower()
    return n


def is_placeholder(value: str) -> bool:
    """Check if a value is a known placeholder."""
    return normalize_value(value) in USER_PLACEHOLDERS


def _strip_frontmatter(content: str) -> str:
    """Remove YAML frontmatter if present."""
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            return content[end + 3 :].lstrip("\n")
    return content


def parse_user_md(content: str) -> UserProfile:
    """Parse USER.md markdown into a UserProfile."""
    content = _strip_frontmatter(content)
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
        label = re.sub(r"[*_]", "", cleaned[:colon_idx]).strip().lower()
        value = re.sub(r"^[*_]+|[*_]+$", "", cleaned[colon_idx + 1 :]).strip()
        if not value or is_placeholder(value):
            continue
        if label == "name":
            profile.name = value
        elif label == "what to call them":
            profile.call_name = value
        elif label == "pronouns":
            profile.pronouns = value
        elif label == "timezone":
            profile.timezone = value
        elif label == "notes":
            profile.notes = value

    # Parse context section
    if context_start != -1:
        ctx_lines = []
        for i in range(context_start, len(lines)):
            line = lines[i]
            if re.match(r"^---\s*$", line) or re.match(r"^#\s", line):
                break
            ctx_lines.append(line)
        ctx = "\n".join(ctx_lines).strip()
        if ctx and not is_placeholder(ctx):
            profile.context = ctx

    return profile


def _profile_is_populated(profile: UserProfile) -> bool:
    """Check if all key fields are populated (skip condition)."""
    return bool(
        profile.name
        and profile.call_name
        and profile.timezone
        and profile.notes
        and profile.context
    )


def merge_user_profiles(existing: UserProfile, extracted: UserProfile) -> UserProfile:
    """Merge extracted profile into existing with fill-only semantics."""
    merged = UserProfile(
        name=existing.name,
        call_name=existing.call_name,
        pronouns=existing.pronouns,
        timezone=existing.timezone,
        notes=existing.notes,
        context=existing.context,
    )
    if not merged.name and extracted.name:
        merged.name = extracted.name
    if not merged.call_name and extracted.call_name:
        merged.call_name = extracted.call_name
    if not merged.pronouns and extracted.pronouns:
        merged.pronouns = extracted.pronouns
    if not merged.timezone and extracted.timezone:
        merged.timezone = extracted.timezone
    if not merged.notes and extracted.notes:
        merged.notes = extracted.notes
    if extracted.context:
        if not merged.context:
            merged.context = extracted.context
        elif extracted.context not in merged.context:
            merged.context = merged.context.rstrip() + "\n" + extracted.context
    return merged


def serialize_user_md(profile: UserProfile) -> str:
    """Serialize a UserProfile back to USER.md markdown."""
    lines = [
        "# USER.md - About Your Human",
        "",
        "_Learn about the person you're helping. Update this as you go._",
        "",
        f"- **Name:** {profile.name or ''}",
        f"- **What to call them:** {profile.call_name or ''}",
        f"- **Pronouns:** {profile.pronouns or '_(optional)_'}",
        f"- **Timezone:** {profile.timezone or ''}",
        f"- **Notes:** {profile.notes or ''}",
        "",
        "## Context",
        "",
        profile.context or "",
        "",
        "---",
        "",
        "The more you know, the better you can help. But remember \u2014 you're learning about a person, not building a dossier. Respect the difference.",
        "",
    ]
    return "\n".join(lines)


async def extract_user_profile(settings, call_info: CallInfo) -> None:
    """Extract user profile from call transcript and merge into USER.md."""
    try:
        transcript_text = format_transcript(call_info.transcript)
        if not transcript_text:
            return

        user_path = workspace_path(settings, "USER.md")
        existing_content = read_workspace_file(user_path)
        existing_profile = (
            parse_user_md(existing_content) if existing_content else UserProfile()
        )

        if _profile_is_populated(existing_profile):
            logger.info(
                "[post-call] Skipping user profile extraction: all fields populated"
            )
            return

        prompt = PROFILE_PROMPT_TEMPLATE.format(transcript=transcript_text)
        raw = await call_anthropic(
            settings.OPENCLAW_GATEWAY_TOKEN,
            prompt,
            PROFILE_SYSTEM_PROMPT,
        )

        if not raw:
            logger.warning("[post-call] User profile extraction returned no result")
            return

        data = parse_json_response(raw)
        if not data:
            return

        extracted = UserProfile(
            name=data.get("name"),
            call_name=data.get("callName"),
            pronouns=data.get("pronouns"),
            timezone=data.get("timezone"),
            notes=data.get("notes"),
            context=data.get("context"),
        )

        merged = merge_user_profiles(existing_profile, extracted)
        write_workspace_file(user_path, serialize_user_md(merged))

        logger.info("[post-call] User profile updated in USER.md")

    except Exception:
        logger.exception("[post-call] Failed to extract user profile")
