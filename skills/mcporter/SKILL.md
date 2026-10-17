---
name: mcporter
description: Use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly (HTTP or stdio), including ad-hoc servers, config edits, and CLI/type generation.
homepage: http://mcporter.dev
metadata:
  {
    "openclaw":
      {
        "emoji": "📦",
        "requires": { "bins": ["mcporter"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter (node)",
            },
          ],
      },
  }
---

# mcporter

Use `mcporter` to work with MCP servers directly.

Quick start

- `mcporter list`
- `mcporter list <server> --schema`
- `mcporter call <server.tool> key=value`

Call tools

- Selector: `mcporter call linear.list_issues team=ENG limit:5`
- Function syntax: `mcporter call "linear.create_issue(title: \"Bug\")"`
- Full URL: `mcporter call https://api.example.com/mcp.fetch url:https://example.com`
- Stdio: `mcporter call --stdio "bun run ./server.ts" scrape url=https://example.com`
- JSON payload: `mcporter call <server.tool> --args '{"limit":5}'`

Auth + config

- OAuth: `mcporter auth <server | url> [--reset]`
- Config: `mcporter config list|get|add|remove|import|login|logout`

Parallel web search (optional)

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) provides
free web search and page fetching without an account or API key for light use.
Anonymous searches use Fast mode. With `mcporter` installed, run from your workspace:

```bash
mcporter config add parallel-search https://search.parallel.ai/mcp \
  --header 'User-Agent=deepclaw-mcporter'
mcporter list parallel-search --schema
mcporter call parallel-search.web_search --args '{"objective":"Find Deepgram streaming speech-to-text documentation","search_queries":["Deepgram streaming speech to text docs"]}' --output json
mcporter call parallel-search.web_fetch --args '{"urls":["https://developers.deepgram.com/docs/interim-results"],"objective":"Understand interim and final streaming transcripts"}' --output json
```

This adds a server to `./config/mcporter.json`. Choose an unused name: `config add`
replaces an existing entry with the same name. Other server entries are preserved.
Use URLs from search results in `web_fetch`. For related calls, include the same
`session_id` in both JSON payloads; generate a new UUID for each conversation.
This is an opt-in CLI workflow; OpenClaw's built-in web tools are unchanged.

Daemon

- `mcporter daemon start|status|stop|restart`

Codegen

- CLI: `mcporter generate-cli --server <name>` or `--command <url>`
- Inspect: `mcporter inspect-cli <path> [--json]`
- TS: `mcporter emit-ts <server> --mode client|types`

Notes

- Config default: `./config/mcporter.json` (override with `--config`).
- Prefer `--output json` for machine-readable results.
