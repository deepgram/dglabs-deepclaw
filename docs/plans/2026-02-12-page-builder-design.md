# Page Builder Extension

DeepClaw extension that gives the agent the ability to build, update, and serve rich web pages on demand. The agent creates structured pages using predefined block types (plus freeform markdown), stores them locally, and shares a localhost URL the user can open in their browser.

## Motivation

The agent communicates via chat channels (WhatsApp, Telegram, etc.) which are great for conversation but limited for presenting structured or visual information. A page gives the agent a canvas to lay out dashboards, briefings, reports, research findings, comparisons — anything that benefits from more than a chat message.

## Architecture

```
User asks for a briefing
        │
        ▼
Agent gathers data (tools, memory, etc.)
        │
        ▼
Agent calls page.create / page.update
        │
        ▼
Extension writes JSON to ~/.openclaw/workspace/.pages/{id}.json
        │
        ▼
Agent replies with link: http://localhost:18789/pages/{id}
        │
        ▼
User opens link → Extension reads JSON → Renders HTML → Serves response
        │
        ▼
Tiny polling script watches /pages/{id}/version → live-reloads on change
```

## Extension: `extensions/page-builder/`

Standard DeepClaw extension registered via the plugin API.

### Registered Components

| Type       | Name                      | Purpose                                                           |
| ---------- | ------------------------- | ----------------------------------------------------------------- |
| Tool       | `page.create`             | Create a new page with title and blocks, returns page ID + URL    |
| Tool       | `page.update`             | Update an existing page (replace all, append, or update by index) |
| Tool       | `page.list`               | List existing pages (id, title, last updated)                     |
| HTTP Route | `GET /pages/{id}`         | Serve rendered HTML page                                          |
| HTTP Route | `GET /pages/{id}/version` | Return current version number (for live-reload polling)           |

### Tool: `page.create`

**Parameters:**

- `title` (string, required) — page title, used in the hero and HTML `<title>`
- `subtitle` (string, optional) — subtitle for the hero block
- `blocks` (array, required) — array of block objects (see Block Types below)

**Returns:**

- `id` (string) — generated UUID
- `url` (string) — full local URL, e.g. `http://localhost:18789/pages/abc123`

**Tool description hint:** "Create a rich visual page when the user asks for something that benefits from structured layout — briefings, reports, research, dashboards, comparisons. For simple answers, just reply in chat."

### Tool: `page.update`

**Parameters:**

- `id` (string, required) — page ID to update
- `title` (string, optional) — update the page title
- `subtitle` (string, optional) — update the subtitle
- `blocks` (array, optional) — full replacement of all blocks
- `append` (array, optional) — append blocks to the end
- `updateAt` (object, optional) — `{ index: number, block: Block }` to update a specific block

**Returns:**

- `version` (number) — new version number after update

Only one of `blocks`, `append`, or `updateAt` should be provided per call.

### Tool: `page.list`

**Parameters:** none

**Returns:**

- Array of `{ id, title, updatedAt }` for all stored pages

## Block Types

### Structured Blocks

#### `hero`

Page header with title and subtitle.

```json
{
  "type": "hero",
  "title": "Morning Briefing",
  "subtitle": "Wednesday, Feb 12",
  "accent": "#00D1A0"
}
```

- `title` (string, required)
- `subtitle` (string, optional)
- `accent` (string, optional) — CSS color for accent styling

#### `cards`

Array of cards, each with title, body, optional icon/emoji and link.

```json
{
  "type": "cards",
  "label": "Today's Highlights",
  "items": [
    { "title": "Weather", "body": "72F, sunny", "icon": "sun" },
    { "title": "Next Meeting", "body": "1:1 with Sarah at 2pm", "link": "https://..." }
  ]
}
```

- `label` (string, optional) — section heading above the cards
- `items` (array, required) — each with `title` (required), `body` (required), `icon` (optional emoji/text), `link` (optional URL)

#### `key-value`

Labeled pairs in a clean grid.

```json
{
  "type": "key-value",
  "label": "Quick Stats",
  "items": [
    { "key": "Open PRs", "value": "3" },
    { "key": "Build Status", "value": "Passing" }
  ]
}
```

- `label` (string, optional)
- `items` (array, required) — each with `key` (string) and `value` (string)

#### `table`

Headers and rows.

```json
{
  "type": "table",
  "label": "Schedule",
  "headers": ["Time", "Event", "Location"],
  "rows": [
    ["9:00 AM", "Standup", "Zoom"],
    ["2:00 PM", "1:1 with Sarah", "Office"]
  ]
}
```

- `label` (string, optional)
- `headers` (array of strings, required)
- `rows` (array of arrays of strings, required)

#### `list`

Ordered or unordered items with optional checkboxes.

```json
{
  "type": "list",
  "label": "Action Items",
  "ordered": false,
  "checkbox": true,
  "items": [
    { "text": "Review PR #42", "checked": false },
    { "text": "Ship voice-call fix", "checked": true }
  ]
}
```

- `label` (string, optional)
- `ordered` (boolean, default false)
- `checkbox` (boolean, default false)
- `items` (array) — each with `text` (string, required), `checked` (boolean, optional, only if `checkbox` is true)

### Freeform Block

#### `markdown`

Raw markdown rendered to HTML. The escape hatch.

```json
{
  "type": "markdown",
  "label": "Notes",
  "content": "## Research Findings\n\nThe data shows..."
}
```

- `label` (string, optional)
- `content` (string, required) — markdown text

### Block Metadata

Every block supports:

- `label` (string, optional) — section heading rendered above the block
- `collapsed` (boolean, default false) — start collapsed, click to expand

## Storage

Pages stored as JSON files in the agent workspace:

```
~/.openclaw/workspace/.pages/
  abc123.json
  def456.json
```

### Page JSON Schema

```json
{
  "id": "abc123",
  "title": "Morning Briefing",
  "subtitle": "Wednesday, Feb 12",
  "version": 3,
  "createdAt": "2026-02-12T08:00:00Z",
  "updatedAt": "2026-02-12T09:15:00Z",
  "blocks": [
    { "type": "hero", "title": "Morning Briefing", "subtitle": "Wednesday, Feb 12" },
    { "type": "cards", "label": "Today", "items": [] },
    { "type": "markdown", "content": "## Notes\n\n..." }
  ]
}
```

The `version` field increments on every `page.update` call.

## Page Rendering

When `GET /pages/{id}` is requested:

1. Read `~/.openclaw/workspace/.pages/{id}.json`
2. Render each block to HTML using template functions (TypeScript string concatenation, no framework)
3. Wrap in a full HTML document with:
   - Inline CSS (dark theme, clean typography, responsive)
   - `<title>` set to the page title
4. Inject a small `<script>` that polls `GET /pages/{id}/version` every 3 seconds
   - If version changes, refetch full page HTML and swap `document.body`
   - No cost when tab is closed; stays live when open

### `GET /pages/{id}/version`

Returns JSON: `{ "version": 3 }`

Used only by the live-reload polling script.

### Styling

- Self-contained inline CSS, no external assets
- Dark background, readable type, good spacing
- Cards: subtle borders, consistent padding
- Tables: alternating row backgrounds
- Markdown: proper prose styling (headings, lists, code, links)
- Responsive: works at any viewport width

## Example Flows

### Morning Briefing

User: "Build me a morning briefing"

1. Agent gathers weather, calendar, tasks, news
2. Calls `page.create` with hero + cards + key-value + list blocks
3. Replies: "Here's your briefing: http://localhost:18789/pages/abc123"

### Research Report

User: "Research competitor X and put together a report"

1. Agent researches using browser/search tools
2. Calls `page.create` with hero + markdown + table + markdown blocks
3. Replies with link

### Refresh Existing Page

User: "Update my briefing"

1. Agent calls `page.list`, finds the briefing page
2. Gathers fresh data
3. Calls `page.update` with new blocks
4. Replies: "Updated — same link: http://localhost:18789/pages/abc123"
5. If user has the page open, it live-reloads automatically

## Out of Scope (v1)

- **Cron-triggered auto-refresh** — natural v2 using existing cron system
- **Charts/images** — text-focused for v1, add as new block types later
- **Public sharing** — pages served on localhost only
- **Authentication** — local access, no auth needed
- **Themes/customization** — single dark theme for v1
