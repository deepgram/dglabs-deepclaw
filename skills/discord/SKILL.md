---
name: discord
description: “Control Discord via the discord tool. Send/edit/delete messages, react, post stickers, upload emojis, run polls, manage threads/pins/search, create/edit/delete channels and categories, fetch permissions or member/role/channel info, set bot presence/activity, and handle moderation. Use when the user asks to interact with Discord channels, DMs, or server management.”
metadata: {“openclaw”:{“emoji”:”🎮”,”requires”:{“config”:[“channels.discord”]}}}
---

# Discord Actions

Use `discord` to manage messages, reactions, threads, polls, and moderation. Disable groups via `discord.actions.*` (defaults enabled, except roles/moderation).

## Input conventions

- `sendMessage` uses `to: “channel:<id>”` or `to: “user:<id>”` for DMs.
- `react`, `readMessages`, `editMessage` use `channelId` directly.
- `fetchMessage` accepts IDs or full links (`https://discord.com/channels/<guildId>/<channelId>/<messageId>`).
- Media: `mediaUrl` with `file:///path` (local) or `https://...` (remote).
- Emoji uploads: PNG/JPG/GIF, <= 256KB. Sticker uploads: PNG/APNG/Lottie JSON, <= 512KB.

## Core actions

### Messages

```json
{“action”: “sendMessage”, “to”: “channel:123”, “content”: “Hello”}
{“action”: “sendMessage”, “to”: “channel:123”, “content”: “With audio”, “mediaUrl”: “file:///tmp/audio.mp3”}
{“action”: “editMessage”, “channelId”: “123”, “messageId”: “456”, “content”: “Fixed”}
{“action”: “deleteMessage”, “channelId”: “123”, “messageId”: “456”}
{“action”: “readMessages”, “channelId”: “123”, “limit”: 20}
{“action”: “fetchMessage”, “guildId”: “999”, “channelId”: “123”, “messageId”: “456”}
{“action”: “fetchMessage”, “messageLink”: “https://discord.com/channels/999/123/456”}
```

Optional `replyTo` with message ID to reply to a specific message.

### Reactions

```json
{“action”: “react”, “channelId”: “123”, “messageId”: “456”, “emoji”: “✅”}
{“action”: “reactions”, “channelId”: “123”, “messageId”: “456”, “limit”: 100}
{“action”: “emojiList”, “guildId”: “999”}
```

### Stickers and emoji uploads

```json
{“action”: “sticker”, “to”: “channel:123”, “stickerIds”: [“9876543210”], “content”: “Nice!”}
{“action”: “emojiUpload”, “guildId”: “999”, “name”: “party_blob”, “mediaUrl”: “file:///tmp/party.png”}
{“action”: “stickerUpload”, “guildId”: “999”, “name”: “wave”, “description”: “Waving hello”, “tags”: “👋”, “mediaUrl”: “file:///tmp/wave.png”}
```

### Polls

```json
{“action”: “poll”, “to”: “channel:123”, “question”: “Lunch?”, “answers”: [“Pizza”, “Sushi”, “Salad”], “allowMultiselect”: false, “durationHours”: 24}
```

`durationHours` defaults to 24; max 768 hours.

### Threads and pins

```json
{“action”: “threadCreate”, “channelId”: “123”, “name”: “Bug triage”, “messageId”: “456”}
{“action”: “threadList”, “guildId”: “999”}
{“action”: “threadReply”, “channelId”: “777”, “content”: “Replying in thread”}
{“action”: “pinMessage”, “channelId”: “123”, “messageId”: “456”}
{“action”: “unpinMessage”, “channelId”: “123”, “messageId”: “456”}
{“action”: “listPins”, “channelId”: “123”}
```

### Search

```json
{“action”: “searchMessages”, “guildId”: “999”, “content”: “release notes”, “channelIds”: [“123”], “limit”: 10}
```

### Info actions

```json
{“action”: “permissions”, “channelId”: “123”}
{“action”: “memberInfo”, “guildId”: “999”, “userId”: “111”}
{“action”: “roleInfo”, “guildId”: “999”}
{“action”: “channelInfo”, “channelId”: “123”}
{“action”: “channelList”, “guildId”: “999”}
{“action”: “voiceStatus”, “guildId”: “999”, “userId”: “111”}
{“action”: “eventList”, “guildId”: “999”}
```

### Channel management (disabled by default, enable via `discord.actions.channels: true`)

```json
{“action”: “channelCreate”, “guildId”: “999”, “name”: “general-chat”, “type”: 0, “parentId”: “888”, “topic”: “General discussion”}
{“action”: “categoryCreate”, “guildId”: “999”, “name”: “Projects”}
{“action”: “channelEdit”, “channelId”: “123”, “name”: “new-name”, “topic”: “Updated topic”}
{“action”: “channelMove”, “guildId”: “999”, “channelId”: “123”, “parentId”: “888”, “position”: 2}
{“action”: “channelDelete”, “channelId”: “123”}
{“action”: “categoryEdit”, “categoryId”: “888”, “name”: “Renamed Category”}
{“action”: “categoryDelete”, “categoryId”: “888”}
```

Channel types: 0 = text, 2 = voice, 4 = category. Edit supports `name`, `topic`, `position`, `parentId`, `nsfw`, `rateLimitPerUser`.

### Roles (disabled by default)

```json
{“action”: “roleAdd”, “guildId”: “999”, “userId”: “111”, “roleId”: “222”}
```

### Moderation (disabled by default)

```json
{“action”: “timeout”, “guildId”: “999”, “userId”: “111”, “durationMinutes”: 10}
```

### Bot presence (disabled by default, enable via `discord.actions.presence: true`)

```json
{“action”: “setPresence”, “activityType”: “playing”, “activityName”: “with fire”}
{“action”: “setPresence”, “activityType”: “custom”, “activityState”: “Vibing”}
{“action”: “setPresence”, “status”: “dnd”}
```

- `activityType`: `playing`, `streaming`, `listening`, `watching`, `competing`, `custom`
- `custom` type: only `activityState` is displayed; `activityName` is ignored
- `status`: `online` (default), `dnd`, `idle`, `invisible`

## Action gating

Disable groups via `discord.actions.*`:

- Enabled by default: `reactions`, `stickers`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`, `emojiUploads`, `stickerUploads`, `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
- Disabled by default: `roles`, `channels`, `moderation`, `presence`

## Discord writing style

- Short, punchy messages (1-3 sentences). No markdown tables (Discord renders them poorly).
- Use **bold** for emphasis, `code` for technical terms, lists for multiple items.
- Avoid headers in casual chat; use **bold** or CAPS instead.
- Match the energy of the conversation. Skip fluff.
