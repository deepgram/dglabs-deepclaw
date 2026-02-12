# Calendar Cache Extension

**Date:** 2026-02-12
**Status:** Design

## Goal

Give the agent proactive calendar awareness by caching Bill's Google Calendar events to a workspace markdown file. Eliminates the n8n webhook round-trip during conversation and ensures the agent always has schedule context.

> **Note:** This is a _personal_ extension — it lives in `billgetman/deepclaw-extensions`
> (cloned to `config/extensions/`) and is loaded via the global extensions discovery
> path (`~/.openclaw/extensions/`). It is **not** deployed to the Fly production image.

## Architecture

```
Every 30 min:
  Extension service timer fires
    → fetch personal calendar (2 days)
    → fetch team calendar (2 days)
    → fetch availability (1 hour)
    → format + write CALENDAR.md to workspace
```

The agent reads `CALENDAR.md` as part of its normal workspace context. The existing calendar skill remains available for on-demand queries with custom time windows.

## Extension Structure

```
extensions/calendar-cache/
  package.json            # workspace package with openclaw.extensions field
  openclaw.plugin.json    # plugin manifest with configSchema
  index.ts                # registerService() entry point
  fetch-calendar.ts       # fetch n8n webhook endpoints
  format-calendar.ts      # transform events → markdown
```

## Components

### index.ts

Registers a background service via `api.registerService()`. The service's `start(ctx)` receives an `OpenClawPluginServiceContext` with `{ config, workspaceDir, stateDir, logger }`.

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { refreshCalendar } from "./fetch-calendar.ts";

export default {
  id: "calendar-cache",
  name: "Calendar Cache",
  register(api: OpenClawPluginApi) {
    const intervalMs = (api.pluginConfig?.intervalMinutes ?? 30) * 60_000;

    api.registerService({
      id: "calendar-cache",
      async start(ctx) {
        await refreshCalendar(ctx, api.pluginConfig);
        const timer = setInterval(() => refreshCalendar(ctx, api.pluginConfig), intervalMs);
        // store for cleanup
        (this as any)._timer = timer;
      },
      stop() {
        clearInterval((this as any)._timer);
      },
    });
  },
};
```

### fetch-calendar.ts

Three `fetch()` calls to the n8n webhook. Reads `GOOGLE_CALENDAR_URL` from `process.env`.

1. **Personal calendar**: `?type=calendar&calendar=bill.getman@deepgram.com&beforeAmount=2&beforeUnit=day`
2. **Team calendar**: `?type=calendar&calendar=c_dlv93964cpbc62o7lde31dirl4@group.calendar.google.com&beforeAmount=2&beforeUnit=day`
3. **Availability**: `?type=availability&beforeAmount=1&beforeUnit=hour`

Handles fetch errors gracefully — logs warning, skips that source, doesn't overwrite good cache with empty data.

Calls `formatCalendar()` with the results and writes to `{ctx.workspaceDir}/CALENDAR.md`.

### format-calendar.ts

Transforms raw Google Calendar event arrays into markdown:

```markdown
# Calendar

_Last updated: 2026-02-12 09:30 AM EST_

## Availability

**Currently available** (next 1 hour)

## Today — Wednesday, Feb 12

| Time                | Event                     | Type     |
| ------------------- | ------------------------- | -------- |
| 11:30 AM – 12:00 PM | Deepclaw Sync             | meeting  |
| 1:00 – 1:30 PM      | Product Roadmap All Hands | meeting  |
| 3:45 – 4:15 PM      | school bus                | personal |

## Tomorrow — Thursday, Feb 13

| Time           | Event      | Type     |
| -------------- | ---------- | -------- |
| 3:45 – 4:15 PM | school bus | personal |

## Deepgram Team Calendar

| Date       | Event                |
| ---------- | -------------------- |
| Wed Feb 18 | No Meeting Wednesday |
```

Logic:

- Group events by date, sort by start time within each day
- Format times in ET (America/New_York)
- Classify `eventType` for the Type column (outOfOffice, focusTime, default → meeting/personal)
- All-day events (team calendar) shown with date only
- Timestamp at top for freshness awareness

## Plugin Manifest

### package.json

```json
{
  "name": "@openclaw/calendar-cache",
  "version": "0.0.1",
  "description": "Caches Google Calendar events to CALENDAR.md",
  "type": "module",
  "devDependencies": {
    "openclaw": "workspace:*"
  },
  "peerDependencies": {
    "openclaw": ">=2026.2.6"
  },
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

### openclaw.plugin.json

```json
{
  "id": "calendar-cache",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "intervalMinutes": { "type": "number" },
      "beforeAmount": { "type": "number" },
      "beforeUnit": { "type": "string" },
      "calendars": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  }
}
```

## openclaw.json Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "calendar-cache": {
        "enabled": true,
        "config": {
          "intervalMinutes": 30,
          "beforeAmount": 2,
          "beforeUnit": "day",
          "calendars": [
            "bill.getman@deepgram.com",
            "c_dlv93964cpbc62o7lde31dirl4@group.calendar.google.com"
          ]
        }
      }
    }
  }
}
```

## Error Handling

- **Fetch failure**: log warning via `ctx.logger`, retain existing CALENDAR.md
- **Partial failure** (one calendar errors): write what we have, note the error in the file
- **Missing env var** (`GOOGLE_CALENDAR_URL`): log error on startup, disable service
- **Missing workspaceDir**: log error, skip write

## Relationship to Existing Skill

The `skills/calendar/SKILL.md` remains for on-demand queries:

- Custom time windows (e.g. "what's on my calendar next Friday?")
- Specific calendar queries beyond the cached window
- Real-time availability checks (fresher than 30-min cache)

The cache handles the common case; the skill handles edge cases.

## Implementation Steps

1. Create `extensions/calendar-cache/` with `package.json` and `openclaw.plugin.json`
2. Implement `fetch-calendar.ts` — fetch wrapper for the three endpoints
3. Implement `format-calendar.ts` — event grouping + markdown formatting
4. Implement `index.ts` — service registration with interval timer
5. Add `calendar-cache` entry to `~/.openclaw/openclaw.json` plugins config
6. Test locally: `pnpm build && pnpm gateway:dev`, verify CALENDAR.md appears
7. Rebuild Docker image (`pnpm build && pnpm ui:build && docker build`)
