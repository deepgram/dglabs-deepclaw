---
name: canvas
description: "Display HTML content (games, visualizations, dashboards) on connected OpenClaw nodes (Mac, iOS, Android) via the canvas tool. Use when the user wants to present, navigate, snapshot, or hide web content on a connected device."
---

# Canvas

Present web content on any connected OpenClaw node's canvas view.

## Actions

- `present` - Show canvas with optional target URL
- `hide` - Hide the canvas
- `navigate` - Navigate to a new URL
- `eval` - Execute JavaScript in the canvas
- `snapshot` - Capture screenshot of canvas

## Configuration

In `~/.openclaw/openclaw.json`:

```json
{
  "canvasHost": {
    "enabled": true,
    "port": 18793,
    "root": "/Users/you/clawd/canvas",
    "liveReload": true
  },
  "gateway": {
    "bind": "auto"
  }
}
```

Bind modes: `loopback` (127.0.0.1), `lan` (LAN IP), `tailnet` (Tailscale hostname), `auto` (best available).

When bound to Tailscale/LAN, nodes receive URLs like `http://<hostname>:18793/__openclaw__/canvas/<file>.html`. Do not use localhost when bound to a non-loopback mode.

## Workflow

1. Place HTML files in the canvas root (default `~/clawd/canvas/`)
2. Determine canvas host URL based on bind mode: `cat ~/.openclaw/openclaw.json | jq '.gateway.bind'`
3. Find connected nodes: `openclaw nodes list`
4. Present: `canvas action:present node:<node-id> target:<full-url>`
5. Navigate/snapshot/hide:

```
canvas action:navigate node:<node-id> url:<new-url>
canvas action:snapshot node:<node-id>
canvas action:hide node:<node-id>
```

## Debugging

- White screen: URL mismatch. Use the hostname matching your bind mode, not localhost. Test with `curl http://<hostname>:18793/__openclaw__/canvas/<file>.html`.
- "node required": Always specify `node:<node-id>`.
- "node not connected": Node is offline. Check `openclaw nodes list`.
- Content not updating: Verify `liveReload: true` in config and file is in the canvas root.

## Notes

- Keep HTML self-contained (inline CSS/JS) for best results.
- `liveReload: true` (default) auto-reloads connected canvases on file changes.
- URL path prefix: `/__openclaw__/canvas/`.
