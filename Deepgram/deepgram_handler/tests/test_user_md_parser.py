from app.services.user_md_parser import (
    UserProfile,
    has_values,
    is_blank_identity,
    parse_calls_md,
    parse_user_markdown,
)

# ---------------------------------------------------------------------------
# parse_user_markdown
# ---------------------------------------------------------------------------

FILLED_USER_MD = """\
# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:** Bill Getman
- **What to call them:** Bill
- **Pronouns:** he/him
- **Timezone:** America/New_York
- **Notes:** Works on DeepClaw, likes coffee

## Context

Building a voice-first AI assistant platform. Cares about latency and clean code.

---

The more you know, the better you can help.
"""

BLANK_USER_MD = """\
# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_

---

The more you know, the better you can help.
"""

PARTIAL_USER_MD = """\
# USER.md - About Your Human

- **Name:** Alice
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:** UTC
- **Notes:**

## Context

---
"""


def test_parse_filled_user_md():
    profile = parse_user_markdown(FILLED_USER_MD)
    assert profile.name == "Bill Getman"
    assert profile.call_name == "Bill"
    assert profile.pronouns == "he/him"
    assert profile.timezone == "America/New_York"
    assert profile.notes == "Works on DeepClaw, likes coffee"
    assert "voice-first" in profile.context


def test_parse_blank_user_md():
    profile = parse_user_markdown(BLANK_USER_MD)
    assert profile.name == ""
    assert profile.call_name == ""
    assert profile.pronouns == ""
    assert profile.timezone == ""
    assert profile.notes == ""
    assert profile.context == ""


def test_parse_partial_user_md():
    profile = parse_user_markdown(PARTIAL_USER_MD)
    assert profile.name == "Alice"
    assert profile.call_name == ""
    assert profile.timezone == "UTC"
    assert profile.context == ""


def test_parse_empty_string():
    profile = parse_user_markdown("")
    assert profile == UserProfile()


def test_placeholder_stripping():
    """Placeholders like _(optional)_ are treated as empty."""
    content = "- **Pronouns:** _(optional)_"
    profile = parse_user_markdown(content)
    assert profile.pronouns == ""


# ---------------------------------------------------------------------------
# has_values
# ---------------------------------------------------------------------------


def test_has_values_true():
    profile = UserProfile(name="Alice")
    assert has_values(profile) is True


def test_has_values_false():
    profile = UserProfile()
    assert has_values(profile) is False


def test_has_values_context_only():
    profile = UserProfile(context="Works on AI stuff")
    assert has_values(profile) is True


# ---------------------------------------------------------------------------
# parse_calls_md
# ---------------------------------------------------------------------------

SAMPLE_CALLS_MD = """\
# Call Log

### 2026-02-10 10:30 — Quick check-in
Asked about the weather and dinner plans. Short call.

### 2026-02-11 14:00 — Calendar review
Went through the week's schedule. Set up reminders for Thursday meeting.

### 2026-02-12 09:15 — Morning standup
Discussed deployment blockers. Needs to fix the webhook URL before next deploy.

### 2026-02-13 16:45 — Voice prompt testing
Testing the new voice prompt builder. Verified first-caller detection works correctly.
"""


def test_parse_calls_md_last_3():
    entries = parse_calls_md(SAMPLE_CALLS_MD, count=3)
    assert len(entries) == 3
    # Last 3 of 4 entries: 2026-02-11, 2026-02-12, 2026-02-13
    assert "2026-02-11" in entries[0]
    assert "2026-02-12" in entries[1]
    assert "2026-02-13" in entries[2]


def test_parse_calls_md_last_1():
    entries = parse_calls_md(SAMPLE_CALLS_MD, count=1)
    assert len(entries) == 1
    assert "Voice prompt testing" in entries[0]


def test_parse_calls_md_all():
    entries = parse_calls_md(SAMPLE_CALLS_MD, count=10)
    assert len(entries) == 4


def test_parse_calls_md_empty():
    assert parse_calls_md("", count=3) == []
    assert parse_calls_md("   ", count=3) == []


def test_parse_calls_md_no_headings():
    assert parse_calls_md("Just some text without headings", count=3) == []


def test_parse_calls_md_truncates_long_body():
    long_body = "x" * 200
    content = f"### 2026-02-13 — Test call\n{long_body}"
    entries = parse_calls_md(content, count=3)
    assert len(entries) == 1
    assert entries[0].endswith("...")
    # heading line + body should be truncated
    body_line = entries[0].split("\n", 1)[1]
    assert len(body_line) == 150


# ---------------------------------------------------------------------------
# is_blank_identity
# ---------------------------------------------------------------------------

BLANK_IDENTITY = """\
# IDENTITY.md - Who Am I?

_Fill this in during your first conversation. Make it yours._

- **Name:**
  _(pick something you like)_
- **Creature:**
  _(AI? robot? familiar? ghost in the machine? something weirder?)_
"""

FILLED_IDENTITY = """\
# IDENTITY.md - Who Am I?

- **Name:** Cleo
- **Creature:** AI familiar
- **Vibe:** sharp and warm
"""

NAME_ONLY_IDENTITY = """\
# IDENTITY.md - Who Am I?

- **Name:** Nova
"""


def test_blank_identity_template():
    assert is_blank_identity(BLANK_IDENTITY) is True


def test_filled_identity():
    assert is_blank_identity(FILLED_IDENTITY) is False


def test_name_only_identity():
    assert is_blank_identity(NAME_ONLY_IDENTITY) is False


def test_blank_identity_empty_string():
    assert is_blank_identity("") is True


def test_blank_identity_none_content():
    assert is_blank_identity("  \n\n  ") is True


def test_blank_identity_no_name_field():
    content = "# IDENTITY.md\nSome stuff but no Name field"
    assert is_blank_identity(content) is True
