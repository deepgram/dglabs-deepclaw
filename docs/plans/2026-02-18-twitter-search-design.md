# Twitter Search Skill Design

## Summary

A new agent skill for searching and monitoring Twitter/X. Follows the same pattern as `reddit-search` and `glean-search` — a `SKILL.md` file with curl-based API examples that the agent uses directly.

## Decisions

- **API**: TwitterAPI.io only (no FxTwitter). Covers search, timelines, replies, mentions, trends, thread context. FxTwitter is free but limited to single-tweet/user lookups with no search capability.
- **Scope**: Read-only research and monitoring. No write actions (posting, liking, retweeting).
- **Location**: `deepclaw-platform/config/skills/twitter-search/SKILL.md` (personal repo only).
- **Auth**: `x-api-key: $TWITTERAPI_API_KEY` header. Key already exists in `deepclaw-platform/.env`.
- **Rate limit**: Free tier is 1 request per 5 seconds. Paid tier is 1000+ RPS.

## Endpoints

All requests use base URL `https://api.twitterapi.io` with header `x-api-key: $TWITTERAPI_API_KEY`.

| #   | Endpoint        | Method | Path                             | Primary Param        | Use Case                                                   |
| --- | --------------- | ------ | -------------------------------- | -------------------- | ---------------------------------------------------------- |
| 1   | Advanced Search | GET    | `/twitter/tweet/advanced_search` | `query`, `queryType` | Primary research tool — find tweets by keyword, user, date |
| 2   | User Profile    | GET    | `/twitter/user/info`             | `userName`           | Look up who someone is                                     |
| 3   | User Timeline   | GET    | `/twitter/user/last_tweets`      | `userName`           | See what an account has been posting                       |
| 4   | Tweet Replies   | GET    | `/twitter/tweet/replies/v2`      | `tweetId`, `sort_by` | Read conversation under a tweet                            |
| 5   | Thread Context  | GET    | `/twitter/tweet/thread_context`  | `tweetId`            | Get full conversation thread                               |
| 6   | User Mentions   | GET    | `/twitter/user/mentions`         | `userName`           | See what people are saying about/to a user                 |
| 7   | Trends          | GET    | `/twitter/trends`                | `woeid`              | Trending topics by location                                |

## Parameter corrections from testing

The official docs have some inaccuracies. Verified parameter names from live testing:

- User endpoints use `userName` (not `screen_name`)
- Tweet endpoints use `tweetId` (not `tweet_id`)
- Reply sorting uses `sort_by` with values `Relevance`, `Latest`, `Likes`
- Search uses `queryType` with values `Latest`, `Top`

## Response structure quirks

- Search, replies, mentions, thread context: `{ "tweets": [...] }` at top level
- User timeline: `{ "data": { "tweets": [...] } }` (wrapped in `data`)
- User profile: `{ "data": { ... } }` (wrapped in `data`)
- Trends: `{ "trends": [{ "trend": { "name", "rank" } }] }`
- Paginated endpoints return `has_next_page` (bool) and `next_cursor` (string)

## Search query syntax

TwitterAPI.io supports standard Twitter advanced search operators:

- `"exact phrase"` — exact match
- `from:username` — tweets by a specific user
- `to:username` — tweets replying to a user
- `since:YYYY-MM-DD_HH:MM:SS_UTC` / `until:...` — date range
- `OR` — boolean or
- `-term` — exclude term
