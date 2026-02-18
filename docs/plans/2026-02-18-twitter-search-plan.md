# Twitter Search Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a twitter-search agent skill that searches Twitter/X via TwitterAPI.io for research and monitoring.

**Architecture:** Single SKILL.md file in `config/skills/twitter-search/`, auto-discovered by OpenClaw. Uses TwitterAPI.io REST API with `x-api-key` auth. Read-only — 7 endpoints covering search, profiles, timelines, replies, threads, mentions, and trends.

**Tech Stack:** Markdown skill file, curl-based API calls, `$TWITTERAPI_API_KEY` env var.

---

### Task 1: Create the skill directory and SKILL.md

**Files:**

- Create: `config/skills/twitter-search/SKILL.md`

**Step 1: Create the directory**

```bash
mkdir -p config/skills/twitter-search
```

**Step 2: Write the SKILL.md file**

Create `config/skills/twitter-search/SKILL.md` with the full skill content. The file must include:

1. YAML frontmatter with `name: twitter-search` and `description`
2. Introduction and "When to Use" section
3. API section with base URL, auth header, and curl examples for all 7 endpoints
4. Parameter reference tables for each endpoint
5. Tweet and user response field tables
6. Tips section

Here is the complete file content:

````markdown
---
name: twitter-search
description: Use when needing to research Twitter/X discussions, track sentiment, monitor mentions, analyze trends, or understand what people are saying about a topic on Twitter/X
---

# Twitter Search

Search Twitter/X for public discussions, sentiment, trending topics, and user activity. Use it whenever a question could benefit from real-time public discourse.

## When to Use

**Proactively search when:**

- Bill asks about public perception, buzz, or discourse around a topic
- Researching what specific people or accounts are saying
- Tracking mentions of a company, product, or person
- Understanding trending topics or breaking news
- Any topic where real-time public conversation matters

**This is a discovery layer** — start broad with search, then drill into replies and threads.

## API

Base URL: `https://api.twitterapi.io`

All requests require:

```
x-api-key: $TWITTERAPI_API_KEY
```

### Advanced Search

Search tweets with full Twitter advanced search syntax.

```bash
curl -s "https://api.twitterapi.io/twitter/tweet/advanced_search?query=deepgram&queryType=Latest" \
  -H "x-api-key: $TWITTERAPI_API_KEY"
```

Search with filters:

```bash
curl -s "https://api.twitterapi.io/twitter/tweet/advanced_search?query=\"voice+api\"+from:elonmusk+since:2025-01-01_00:00:00_UTC&queryType=Top" \
  -H "x-api-key: $TWITTERAPI_API_KEY"
```

Returns `{ "tweets": [...], "has_next_page": bool, "next_cursor": "..." }`.

### User Profile

Look up a user by handle.

```bash
curl -s "https://api.twitterapi.io/twitter/user/info?userName=DeepgramAI" \
  -H "x-api-key: $TWITTERAPI_API_KEY"
```

Returns `{ "data": { ...user fields } }`.

### User Timeline

Get recent tweets from a specific account.

```bash
curl -s "https://api.twitterapi.io/twitter/user/last_tweets?userName=DeepgramAI" \
  -H "x-api-key: $TWITTERAPI_API_KEY"
```

Returns `{ "data": { "tweets": [...], "has_next_page": bool, "next_cursor": "..." } }`.

### Tweet Replies

Read the conversation under a tweet.

```bash
curl -s "https://api.twitterapi.io/twitter/tweet/replies/v2?tweetId=1846987139428634858&sort_by=Relevance" \
  -H "x-api-key: $TWITTERAPI_API_KEY"
```

Returns `{ "tweets": [...], "has_next_page": bool, "next_cursor": "..." }`.

### Thread Context

Get the full conversation thread for a tweet.

```bash
curl -s "https://api.twitterapi.io/twitter/tweet/thread_context?tweetId=1846987139428634858" \
  -H "x-api-key: $TWITTERAPI_API_KEY"
```

Returns `{ "tweets": [...] }`.

### User Mentions

See what people are saying about or to a user.

```bash
curl -s "https://api.twitterapi.io/twitter/user/mentions?userName=DeepgramAI" \
  -H "x-api-key: $TWITTERAPI_API_KEY"
```

Returns `{ "tweets": [...], "has_next_page": bool, "next_cursor": "..." }`.

### Trends

Get trending topics by location.

```bash
curl -s "https://api.twitterapi.io/twitter/trends?woeid=1" \
  -H "x-api-key: $TWITTERAPI_API_KEY"
```

Returns `{ "trends": [{ "trend": { "name": "...", "rank": 1 } }, ...] }`.

## Parameter Reference

### Advanced Search

| Parameter   | Required | Default  | Description                                                                                                                                  |
| ----------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`     | yes      | —        | Search terms with advanced syntax (`"exact phrase"`, `from:user`, `to:user`, `since:YYYY-MM-DD_HH:MM:SS_UTC`, `until:...`, `OR`, `-exclude`) |
| `queryType` | no       | `Latest` | `Latest` or `Top`                                                                                                                            |
| `cursor`    | no       | —        | Pagination cursor from previous response                                                                                                     |

### User Profile / User Timeline / User Mentions

| Parameter  | Required | Description        |
| ---------- | -------- | ------------------ |
| `userName` | yes      | Username without @ |
| `cursor`   | no       | Pagination cursor  |

### Tweet Replies

| Parameter | Required | Default     | Description                       |
| --------- | -------- | ----------- | --------------------------------- |
| `tweetId` | yes      | —           | Tweet ID                          |
| `sort_by` | no       | `Relevance` | `Relevance`, `Latest`, or `Likes` |
| `cursor`  | no       | —           | Pagination cursor                 |

### Thread Context

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `tweetId` | yes      | Tweet ID    |

### Trends

| Parameter | Required | Default | Description                                          |
| --------- | -------- | ------- | ---------------------------------------------------- |
| `woeid`   | yes      | —       | Where On Earth ID (`1` = worldwide, `23424977` = US) |

## Response Fields

### Tweet fields

| Field               | Description                                |
| ------------------- | ------------------------------------------ |
| `id`                | Tweet ID (use for replies, thread context) |
| `text`              | Tweet content                              |
| `url`               | Full tweet URL                             |
| `createdAt`         | Timestamp                                  |
| `author.userName`   | Author handle                              |
| `author.name`       | Display name                               |
| `likeCount`         | Likes                                      |
| `retweetCount`      | Retweets                                   |
| `replyCount`        | Replies                                    |
| `viewCount`         | Views                                      |
| `quoteCount`        | Quote tweets                               |
| `bookmarkCount`     | Bookmarks                                  |
| `lang`              | Language code                              |
| `entities`          | Hashtags, URLs, mentions                   |
| `isReply`           | Whether it's a reply                       |
| `inReplyToUsername` | Who it replies to                          |
| `conversationId`    | Thread conversation ID                     |

### User fields

| Field            | Description           |
| ---------------- | --------------------- |
| `userName`       | Handle                |
| `name`           | Display name          |
| `description`    | Bio                   |
| `location`       | Stated location       |
| `followers`      | Follower count        |
| `following`      | Following count       |
| `statusesCount`  | Tweet count           |
| `isBlueVerified` | Blue check            |
| `createdAt`      | Account creation date |

## Tips

- **Start with advanced search** to find relevant tweets, then use replies or thread context to read the actual discussion.
- **Use Twitter search operators** — `"exact phrase"`, `from:user`, `to:user`, `since:2025-01-01_00:00:00_UTC`, `until:...`, `OR`, `-exclude`. Combine freely.
- **`queryType=Top` for signal, `Latest` for recency** — Top surfaces high-engagement tweets; Latest gives chronological results.
- **Replies are the gold** — tweet text shows the topic, but replies reveal real opinions and pushback.
- **Rate limit: 1 request per 5 seconds** on the free tier. Don't fire requests in rapid succession.
- **Pagination** — paginated endpoints return `has_next_page` and `next_cursor`. Pass `cursor=<value>` for the next page. Keep page fetches small for initial exploration.
- **Trends are global by default** (`woeid=1`). Use `woeid=23424977` for US trends.
````

**Step 3: Commit**

```bash
git add config/skills/twitter-search/SKILL.md
git commit -m "feat: add twitter-search skill"
```

---

### Task 2: Verify the skill works end-to-end

**Step 1: Verify the file is discoverable**

```bash
ls -la config/skills/twitter-search/SKILL.md
```

Expected: file exists with the correct content.

**Step 2: Test each endpoint with curl**

Run each curl command from the skill doc against the live API to confirm they work. Use the `TWITTERAPI_API_KEY` from `deepclaw-platform/.env`. Wait 6 seconds between requests (free tier rate limit).

```bash
source .env

# Advanced search
curl -s "https://api.twitterapi.io/twitter/tweet/advanced_search?query=deepgram&queryType=Latest" \
  -H "x-api-key: $TWITTERAPI_API_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Search: {len(d.get(\"tweets\",[]))} tweets')"

sleep 6

# User profile
curl -s "https://api.twitterapi.io/twitter/user/info?userName=DeepgramAI" \
  -H "x-api-key: $TWITTERAPI_API_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'User: {d[\"data\"][\"name\"]}')"

sleep 6

# User timeline
curl -s "https://api.twitterapi.io/twitter/user/last_tweets?userName=DeepgramAI" \
  -H "x-api-key: $TWITTERAPI_API_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Timeline: {len(d[\"data\"][\"tweets\"])} tweets')"

sleep 6

# Mentions
curl -s "https://api.twitterapi.io/twitter/user/mentions?userName=DeepgramAI" \
  -H "x-api-key: $TWITTERAPI_API_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Mentions: {len(d.get(\"tweets\",[]))} tweets')"

sleep 6

# Trends
curl -s "https://api.twitterapi.io/twitter/trends?woeid=23424977" \
  -H "x-api-key: $TWITTERAPI_API_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Trends: {len(d.get(\"trends\",[]))} trends')"
```

Expected: all 5 commands print success counts with no errors.

**Step 3: Verify frontmatter parses correctly**

```bash
head -4 config/skills/twitter-search/SKILL.md
```

Expected:

```
---
name: twitter-search
description: Use when needing to research Twitter/X discussions...
---
```
