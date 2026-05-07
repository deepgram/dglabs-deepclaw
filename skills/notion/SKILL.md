---
name: notion
description: "Create, read, update, and query Notion pages, databases (data sources), and blocks via the Notion API. Use when the user asks to manage content in Notion, search pages, query databases, update properties, or organize workspace content."
metadata:
  {
    "openclaw":
      { "emoji": "📝", "requires": { "env": ["NOTION_API_KEY"] }, "primaryEnv": "NOTION_API_KEY" },
  }
---

# notion

Use the Notion API to create/read/update pages, data sources (databases), and blocks.

## Setup

1. Create an integration at https://notion.so/my-integrations
2. Copy the API key (starts with `ntn_` or `secret_`), store in `~/.config/notion/api_key`
3. Share target pages/databases with your integration ("..." > "Connect to" > integration name)

## API Basics

All requests require these headers (Notion-Version `2025-09-03`):

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
NOTION_HEADERS='-H "Authorization: Bearer $NOTION_KEY" -H "Notion-Version: 2025-09-03" -H "Content-Type: application/json"'
```

## Common Operations

```bash
# Search
curl -X POST "https://api.notion.com/v1/search" $NOTION_HEADERS -d '{"query": "page title"}'

# Get page / page content
curl "https://api.notion.com/v1/pages/{page_id}" $NOTION_HEADERS
curl "https://api.notion.com/v1/blocks/{page_id}/children" $NOTION_HEADERS

# Create page in a database
curl -X POST "https://api.notion.com/v1/pages" $NOTION_HEADERS \
  -d '{"parent":{"database_id":"xxx"},"properties":{"Name":{"title":[{"text":{"content":"New Item"}}]},"Status":{"select":{"name":"Todo"}}}}'

# Query a data source
curl -X POST "https://api.notion.com/v1/data_sources/{data_source_id}/query" $NOTION_HEADERS \
  -d '{"filter":{"property":"Status","select":{"equals":"Active"}},"sorts":[{"property":"Date","direction":"descending"}]}'

# Create a data source
curl -X POST "https://api.notion.com/v1/data_sources" $NOTION_HEADERS \
  -d '{"parent":{"page_id":"xxx"},"title":[{"text":{"content":"My Database"}}],"properties":{"Name":{"title":{}},"Status":{"select":{"options":[{"name":"Todo"},{"name":"Done"}]}},"Date":{"date":{}}}}'

# Update page properties
curl -X PATCH "https://api.notion.com/v1/pages/{page_id}" $NOTION_HEADERS \
  -d '{"properties":{"Status":{"select":{"name":"Done"}}}}'

# Add blocks to page
curl -X PATCH "https://api.notion.com/v1/blocks/{page_id}/children" $NOTION_HEADERS \
  -d '{"children":[{"object":"block","type":"paragraph","paragraph":{"rich_text":[{"text":{"content":"Hello"}}]}}]}'
```

## Property Types

- **Title:** `{"title": [{"text": {"content": "..."}}]}`
- **Rich text:** `{"rich_text": [{"text": {"content": "..."}}]}`
- **Select:** `{"select": {"name": "Option"}}` / **Multi-select:** `{"multi_select": [{"name": "A"}]}`
- **Date:** `{"date": {"start": "2024-01-15"}}` / **Checkbox:** `{"checkbox": true}`
- **Number:** `{"number": 42}` / **URL:** `{"url": "https://..."}` / **Email:** `{"email": "a@b.com"}`
- **Relation:** `{"relation": [{"id": "page_id"}]}`

## API Version 2025-09-03 Notes

- Databases are now "data sources": use `/data_sources/` endpoints for queries
- Each database has both `database_id` (for creating pages) and `data_source_id` (for querying)
- Search returns databases as `"object": "data_source"`
- Page/database IDs are UUIDs (with or without dashes)
- Rate limit: ~3 req/sec. View filters are UI-only.
- Use `is_inline: true` when creating data sources to embed in pages
