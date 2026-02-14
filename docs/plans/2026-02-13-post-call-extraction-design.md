# Post-Call Extraction Pipeline — Python Sidecar

**Branch**: `fix/voice-agent-prompting`
**Date**: 2026-02-13

---

## Overview

Port the post-call extraction pipeline (call summary, user profile, agent identity) from the TypeScript voice-call extension into the Python Deepgram sidecar. All three tasks run as standalone async functions that call the Anthropic API directly (Claude Sonnet) and write workspace markdown files via the filesystem.

## Architecture

```
Call ends → run_agent_bridge finally block
              ↓
         asyncio.gather (fire-and-forget, return_exceptions=True)
              ├── generate_call_summary()    → CALLS.md
              ├── extract_user_profile()     → USER.md
              ├── extract_agent_identity()   → IDENTITY.md
              └── _generate_next_greeting()  → NEXT_GREETING.txt (existing)
```

All four tasks run concurrently. Each logs its own errors and never raises.

## Design Decisions

- **Python sidecar, not TypeScript extension**: The sidecar already owns the Deepgram session lifecycle on this branch. No gateway dependency.
- **Direct Anthropic API**: Same pattern as `filler.py`. Uses `ANTHROPIC_API_KEY` already in config. No gateway needed for extraction.
- **Direct filesystem writes**: Sidecar runs on the host with access to `~/.openclaw/workspace/`. No gateway RPC needed.
- **Claude Sonnet**: `claude-sonnet-4-5-20250929` for all extraction. Post-call latency doesn't matter; quality does.
- **Replicate TypeScript merge semantics exactly**: Fill-only for USER.md and IDENTITY.md. Same placeholder detection. Same generic name filtering.
- **All 3 tasks**: Call summary, user profile, agent identity. They share the same pattern so building all 3 isn't much more work than 1.
- **Inbound calls only**: Outbound calls (prompt_override set) skip extraction since the callee isn't the user.

---

## Component 1: Transcript Capture

Accumulate `ConversationText` events from Deepgram during the bridge session.

**Data structure:**

```python
@dataclass
class TranscriptEntry:
    timestamp: float       # time.time()
    speaker: str           # "bot" | "user"
    text: str
```

**Capture point** — in `_deepgram_to_twilio`, when `msg_type == "ConversationText"`:

```python
speaker = "user" if role == "user" else "bot"
transcript.append(TranscriptEntry(timestamp=time.time(), speaker=speaker, text=content))
```

**Transcript formatting** (shared helper):

```
Agent: Hey! What can I do for you?
Caller: Hi, I'm looking for a good chicken recipe
```

---

## Component 2: Post-Call Pipeline Trigger

Expand the `run_agent_bridge()` finally block to fire all extraction tasks.

**CallInfo dataclass:**

```python
@dataclass
class CallInfo:
    call_id: str
    phone_number: str        # E.164 format
    direction: str           # "inbound" | "outbound"
    ended_at: float          # time.time()
    transcript: list[TranscriptEntry]
```

**Trigger conditions:**

- `prompt_override` is None (inbound call)
- `transcript` is non-empty (conversation happened)
- `settings.POST_CALL_EXTRACTION` is True

**Execution:**

```python
await asyncio.gather(
    generate_call_summary(settings, call_info),
    extract_user_profile(settings, call_info),
    extract_agent_identity(settings, call_info),
    _generate_next_greeting(settings, session_key=session_key),
    return_exceptions=True,
)
```

---

## Component 3: Workspace File I/O

Shared module for path resolution and file operations.

**Path resolution:**

```python
WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace"

def workspace_path(settings: Settings, filename: str) -> Path:
    base = WORKSPACE_DIR
    if settings.OPENCLAW_AGENT_ID != "main":
        base = base / settings.OPENCLAW_AGENT_ID
    return base / filename
```

**Helpers:**

- `read_workspace_file(path) -> str | None` — safe read, returns None on missing/empty
- `write_workspace_file(path, content)` — creates parent dirs, writes content
- `format_transcript(transcript) -> str` — formats as `Agent: ...\nCaller: ...`
- `call_anthropic(api_key, prompt, system_prompt) -> str | None` — shared Sonnet caller with timeout and error handling
- `parse_json_response(raw) -> dict | None` — strips code fences, parses JSON, logs failures

---

## Component 4: Call Summary (CALLS.md)

**File:** `app/services/call_summary.py`

**Extraction prompt:**

```
Summarize this phone call concisely. Include: who called, what was discussed,
any specific requests or topics (name them), any action items or outcomes,
and anything the caller might appreciate being remembered next time.
Write plain text only -- no markdown formatting, no bullet points.
```

LLM receives call direction, phone number, and formatted transcript. Returns plain text (not JSON).

**CALLS.md format:**

```markdown
# Call History

### 02/13/2026, 3:45 PM -- +15551234567 (inbound)

Summary text...
```

**Append + trim logic:**

1. Read existing CALLS.md or start with `# Call History\n\n`
2. Format timestamp in configured timezone (`settings.TIMEZONE`)
3. Build entry: `### {timestamp} -- {phone} ({direction})\n{summary}\n`
4. Append to content
5. Split on `### ` headings, keep header + last N entries (`settings.CALLS_MAX_ENTRIES`, default 50)
6. Write back

---

## Component 5: User Profile (USER.md)

**File:** `app/services/user_profile.py`

**Extraction prompt:**

```
Extract user profile information from this phone call transcript.
Return ONLY a JSON object with fields you can confidently extract.

Fields:
- "name": Their full name if stated
- "callName": What they prefer to be called
- "pronouns": If mentioned or clearly implied
- "timezone": Only if explicitly stated or strongly implied
- "notes": Quick facts worth remembering
- "context": What they care about (1-2 sentences)

Only include fields supported by clear evidence. Do NOT guess.
Return valid JSON only, no markdown.
```

**UserProfile dataclass:**

```python
@dataclass
class UserProfile:
    name: str | None
    call_name: str | None
    pronouns: str | None
    timezone: str | None
    notes: str | None
    context: str | None
```

**Parser:** Extracts `**Field:** value` definition list + `## Context` section from markdown. Strips frontmatter.

**Merge strategy — fill-only:**

- `name`, `call_name`, `pronouns`, `timezone`, `notes`: only set if existing value is empty/placeholder
- `context`: appended with dedup check (skip if new text already in existing)
- No field is ever overwritten once set

**Placeholder detection:**

```python
PLACEHOLDERS = {
    "optional",
    "what do they care about? what projects are they working on? ...",
}
```

Values normalized (lowercase, strip markdown, strip parens) before comparison.

**Skip conditions:**

1. Transcript empty
2. All fields already populated with non-placeholder values

**Serializer:** Writes back the same markdown format with header, definition list, `## Context` section, and footer.

---

## Component 6: Agent Identity (IDENTITY.md)

**File:** `app/services/agent_identity.py`

**Extraction prompt:**

```
Extract the AI agent's self-chosen identity from this phone call transcript.
Focus on how the AGENT introduced or described itself -- not the caller.

Fields:
- "name": The name the agent used to introduce itself
- "creature": How the agent described what it is
- "vibe": The agent's personality/tone
- "emoji": Any emoji the agent associated with itself

If no name was established, PICK a distinctive, personal name --
something like "Wren", "Ember", "Moss", "Sable". Not generic.
Return valid JSON only, no markdown.
```

**AgentIdentity dataclass:**

```python
@dataclass
class AgentIdentity:
    name: str | None
    creature: str | None
    vibe: str | None
    emoji: str | None
    avatar: str | None  # parsed but never written by extraction
```

**Merge strategy — fill-only:** Each field set only if existing value is empty/placeholder. `avatar` never touched.

**Generic name detection:**

```python
GENERIC_NAMES = {"voice agent", "assistant", "ai", "ai assistant", "bot", "agent", "helper"}
```

Extracted name discarded if it matches (case-insensitive).

**Placeholder detection:**

```python
IDENTITY_PLACEHOLDERS = {
    "pick something you like",
    "ai? robot? familiar? ghost in the machine? something weirder?",
    "how do you come across? sharp? warm? chaotic? calm?",
    "your signature - pick one that feels right",
    "workspace-relative path, http(s) url, or data uri",
}
```

**Skip condition:** Extraction skipped entirely if any field already has a non-placeholder value. Only runs for first call (or until agent gets at least one identity field).

---

## Configuration

New settings in `app/config.py`:

```python
TIMEZONE: str = "UTC"
CALLS_MAX_ENTRIES: int = 50
POST_CALL_EXTRACTION: bool = True  # master toggle
```

`ANTHROPIC_API_KEY` already exists (for fillers). Sonnet uses the same key.

---

## File Inventory

**New files:**

| File                             | Purpose                                                                   |
| -------------------------------- | ------------------------------------------------------------------------- |
| `app/services/call_summary.py`   | CALLS.md extraction + append/trim                                         |
| `app/services/user_profile.py`   | USER.md extraction + parse/merge/serialize                                |
| `app/services/agent_identity.py` | IDENTITY.md extraction + parse/merge/serialize                            |
| `app/services/workspace.py`      | Shared: paths, file I/O, transcript format, Anthropic caller, JSON parser |
| `tests/test_call_summary.py`     | Summary generation, append, trim                                          |
| `tests/test_user_profile.py`     | Parsing, merge, placeholders, serialization                               |
| `tests/test_agent_identity.py`   | Parsing, merge, generic names, skip logic                                 |
| `tests/test_workspace.py`        | Path resolution, transcript formatting                                    |

**Modified files:**

| File                             | Change                                                |
| -------------------------------- | ----------------------------------------------------- |
| `app/services/deepgram_agent.py` | Transcript capture + extraction pipeline trigger      |
| `app/config.py`                  | Add TIMEZONE, CALLS_MAX_ENTRIES, POST_CALL_EXTRACTION |
| `tests/conftest.py`              | Defaults for new settings                             |

**No changes to:** routers, proxy, SMS, filler logic, session registry, anything outside `Deepgram/deepgram_handler/`.
