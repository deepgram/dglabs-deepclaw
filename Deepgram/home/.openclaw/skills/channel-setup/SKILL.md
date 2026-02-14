---
name: channel-setup
description: Set up messaging channels (Telegram, Discord, Slack) on this OpenClaw instance
---

You can enable messaging channels so users can reach you through Telegram, Discord, Slack, etc. This requires writing the correct config to your OpenClaw config file.

## Critical: plugin system

OpenClaw has TWO config layers for channels:

1. `channels.<channel>` — channel-specific settings (token, policies, etc.)
2. `plugins.entries.<channel>.enabled` — whether the channel plugin is loaded at all

**You MUST set both in a single config write.** If you only set `channels.<channel>`, the gateway will auto-register the plugin as DISABLED and it won't start. You'll see "configured, not enabled yet" in logs.

## Config file location

Your config file is at `~/.openclaw/openclaw.json`. Read it first, merge your changes, and write the full updated JSON back.

## Setting up Telegram

Requirements: a bot token from @BotFather on Telegram.

Merge this into your existing config (keep all existing keys):

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "<token-from-botfather>",
      "dmPolicy": "pairing"
    }
  },
  "plugins": {
    "entries": {
      "telegram": { "enabled": true }
    }
  }
}
```

After writing the config, the gateway will auto-restart within a few seconds. Then:

1. The user should send `/start` to the bot on Telegram
2. The bot will reply with a pairing code
3. Approve it: `openclaw pairing approve telegram <CODE>`

To skip pairing (allow all DMs): set `"dmPolicy": "open"` instead of `"pairing"`.

To restrict to specific users: set `"dmPolicy": "allowlist"` and add `"allowFrom": ["<telegram-user-id>"]`.

## Setting up Discord

Merge this into your existing config:

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "<discord-bot-token>"
    }
  },
  "plugins": {
    "entries": {
      "discord": { "enabled": true }
    }
  }
}
```

## Setting up Slack

Merge this into your existing config:

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "botToken": "<xoxb-...>",
      "appToken": "<xapp-...>"
    }
  },
  "plugins": {
    "entries": {
      "slack": { "enabled": true }
    }
  }
}
```

## Troubleshooting

**"configured, not enabled yet"** — You forgot `plugins.entries.<channel>.enabled: true`. Read the config, add it, write back.

**"Permission denied" running `openclaw`** — The CLI should be at `/usr/local/bin/openclaw`. If it's missing, use `node /app/openclaw.mjs` as a fallback.

**Gateway log location** — Logs are at `/tmp/openclaw/openclaw-<YYYY-MM-DD>.log`, NOT at `~/.openclaw/logs/gateway.log`.

**Pairing codes** — List pending: `openclaw pairing list telegram`. Approve: `openclaw pairing approve telegram <CODE>`.
