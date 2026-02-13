# Unified Voice + SMS Agent

## Problem

Voice calls and SMS messages route to different agents (`voice-agent` vs `main`), giving them separate workspaces. This means separate USER.md, CALLS.md, and memory files. A user's text conversation has no idea what happened on a voice call and vice versa.

## Solution

Route SMS to the same `voice-agent` that handles voice calls using the existing binding system. Update the agent's startup instructions to read CALLS.md so SMS sessions are aware of call history.

## Changes

### 1. Add SMS → voice-agent binding (both config files)

Add a `bindings` array at the top level of `config/openclaw.json` and `config/openclaw.fly.json`:

```json
"bindings": [
  {
    "agentId": "voice-agent",
    "match": { "channel": "twilio-sms", "accountId": "*" }
  }
]
```

The wildcard `accountId: "*"` matches any Twilio account. The binding system in `src/routing/resolve-route.ts` already supports this — no code changes needed.

### 2. Update voice-agent AGENTS.md to read CALLS.md

In `data/workspace/voice-agent/AGENTS.md`, add CALLS.md to the "Every Session" startup checklist:

```markdown
## Every Session

Before doing anything else:

1. Read `SOUL.md` — this is who you are
2. Read `USER.md` — this is who you're helping
3. Read `CALLS.md` — recent voice call history (if it exists)
4. Read `memory/YYYY-MM-DD.md` (today + yesterday) for recent context
5. **If in MAIN SESSION** (direct chat with your human): Also read `MEMORY.md`
```

This gives SMS sessions awareness of recent voice conversations. Voice calls already get SMS awareness via `loadRecentNonVoiceSessions()` in `deepgram-media-bridge.ts`.

## What This Achieves

After these changes, voice and SMS share:

- **USER.md** — single user profile across both channels
- **CALLS.md** — SMS can reference recent voice calls
- **memory/** — shared daily notes and long-term memory
- **SOUL.md / identity** — consistent personality
- **Skills** — SMS gets access to voice-agent's full skill set (notion, slack, weather, calendar, etc.)

Cross-channel briefing works in both directions:

- Voice → SMS: `loadRecentNonVoiceSessions()` (already exists)
- SMS → Voice: CALLS.md read at session start (new)

## Files Changed

| File                                   | Change                            |
| -------------------------------------- | --------------------------------- |
| `config/openclaw.json`                 | Add `bindings` array              |
| `config/openclaw.fly.json`             | Add `bindings` array              |
| `data/workspace/voice-agent/AGENTS.md` | Add CALLS.md to startup checklist |
