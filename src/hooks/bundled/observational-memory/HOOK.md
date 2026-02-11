---
name: observational-memory
description: "Extract and maintain structured observations from conversations"
homepage: https://docs.openclaw.ai/hooks#observational-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "\uD83D\uDD2D",
        "events": ["agent:turn-complete"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Observational Memory Hook

Automatically extracts structured observations from conversations after each agent turn and maintains them in `OBSERVATIONS.md`.

## What It Does

After each agent turn completes:

1. **Counts turns** - Only runs every N turns (default: 3) to avoid excessive LLM calls
2. **Reads recent messages** - Extracts the last N user/assistant messages from the session transcript (default: 20)
3. **Calls Observer LLM** - Uses a cheap/fast model to extract structured observations with priority markers
4. **Updates OBSERVATIONS.md** - Writes the updated observations to the workspace bootstrap file
5. **Runs Reflector** - When observations exceed a size threshold, consolidates older entries

Because `OBSERVATIONS.md` is a workspace bootstrap file, it is automatically injected into the agent's system prompt on every turn — no tool calls needed.

**Note:** The observer only runs for top-level agent turns. Subagent/embedded calls (e.g. memory-flush, slug-generator) do not fire `agent:turn-complete` events, so the observer is never triggered by internal sidecar LLM calls.

## Observation Format

```markdown
# Observations

## 2026-02-10

### Key Facts

- Red circle (14:30) User is building a Next.js app with Supabase auth
  - Red circle (14:30) App uses server components
  - Yellow circle (14:35) User asked about middleware config

### Preferences & Decisions

- Red circle User prefers TypeScript strict mode

<current-task>Building auth middleware</current-task>
<suggested-context>Continue with route protection setup</suggested-context>
```

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "observational-memory": {
          "enabled": true,
          "messages": 20,
          "triggerEveryNTurns": 3,
          "maxObservationsChars": 15000,
          "reflectorThresholdChars": 12000
        }
      }
    }
  }
}
```

| Option                    | Type    | Default | Description                                   |
| ------------------------- | ------- | ------- | --------------------------------------------- |
| `enabled`                 | boolean | true    | Enable/disable the hook                       |
| `messages`                | number  | 20      | Number of recent messages to send to observer |
| `triggerEveryNTurns`      | number  | 3       | Run observer every N agent turns              |
| `maxObservationsChars`    | number  | 15000   | Max chars for OBSERVATIONS.md                 |
| `reflectorThresholdChars` | number  | 12000   | Trigger reflector consolidation above this    |

## Model Configuration

By default, the observer uses the agent's configured model. For cost efficiency, configure a dedicated cheap model:

```json
{
  "agents": {
    "defaults": {
      "observationalMemory": {
        "enabled": true,
        "provider": "google",
        "model": "gemini-2.0-flash"
      }
    }
  }
}
```

## Configuration Split

Configuration lives in two places:

- **Hook-level config** (`hooks.internal.entries.observational-memory.*`) — controls hook behavior: turn frequency, message count, size thresholds
- **Agent-level config** (`agents.defaults.observationalMemory.*`) — controls model selection and enable/disable: provider, model, enabled

This split keeps model configuration alongside other agent defaults while hook-specific tuning stays with the hook system.

## Disabling

```bash
openclaw hooks disable observational-memory
```

Or in config:

```json
{
  "agents": {
    "defaults": {
      "observationalMemory": {
        "enabled": false
      }
    }
  }
}
```
