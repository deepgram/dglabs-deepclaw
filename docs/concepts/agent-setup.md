---
summary: "How agent creation works: config, workspace, bootstrap files, identity, and voice integration"
read_when:
  - Creating or configuring agents
  - Understanding the bootstrap ritual and workspace files
  - Debugging agent identity or workspace issues
  - Working on the voice-call extension's CALLS.md integration
title: "Agent Setup"
---

# Agent Setup

How OpenClaw creates agents, initializes their workspace, and wires up identity.

## Overview

Each agent has two halves:

1. **Config entry** — a record in `openclaw.json` under `agents.list[]` that controls model, tools, sandbox, and routing.
2. **Workspace** — a directory of markdown files that get injected into the system prompt at session start. This is the agent's personality, memory, and operating instructions.

Config defines what the agent _can do_. The workspace defines who the agent _is_.

## Creation Flow

Whether you run `openclaw agents add` (CLI) or call `agents.create` (gateway RPC), the same steps happen:

```
1. Validate
   └─ Normalize agent ID, reject duplicates and reserved ID "openclaw"

2. Config
   └─ applyAgentConfig() adds an entry to agents.list[] in openclaw.json
      Fields: id, name, workspace, model, identity, sandbox, tools, skills

3. Workspace
   └─ ensureAgentWorkspace() creates the workspace directory
      └─ Loads templates from docs/reference/templates/
      └─ writeFileIfMissing() for each file (flag "wx" = never overwrite)
      └─ git init if brand-new workspace and git is available

4. Agent directory
   └─ Creates ~/.openclaw/agents/{agentId}/agent/ for state (models, auth)

5. Sessions directory
   └─ Creates ~/.openclaw/agents/{agentId}/sessions/ for transcripts

6. Identity
   └─ Appends name/emoji/avatar to IDENTITY.md if provided at creation time
```

### Code paths

- **CLI**: `src/commands/agents.commands.add.ts` — interactive wizard or `--name`/`--workspace` flags
- **Gateway**: `src/gateway/server-methods/agents.ts` — `agents.create` RPC method
- **Workspace init**: `src/agents/workspace.ts` — `ensureAgentWorkspace()`
- **Config write**: `src/commands/agents.config.ts` — `applyAgentConfig()`

### Multi-agent workspace isolation

The default agent uses `~/.openclaw/workspace`. Non-default agents get their own workspace at `~/.openclaw/workspace-{agentId}` (or a custom path via `agents.list[].workspace`).

When creating a non-default agent, the system symlinks the new agent's `USER.md` to the default agent's `USER.md` using a **relative path** so all agents share the same user profile. Relative symlinks work inside Docker where mount points differ from the host.

## Bootstrap Files

Templates live in `docs/reference/templates/`. On workspace creation, each is written via `writeFileIfMissing()` — existing files are never overwritten.

### File reference

| File                   | Loaded             | Purpose                                                                                                               | Template                   |
| ---------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `AGENTS.md`            | Every session      | Operating instructions: session procedures, memory rules, safety, group chat behavior, heartbeat guidance             | Yes                        |
| `SOUL.md`              | Every session      | Personality, principles, boundaries. Agent-writable — the agent can evolve this file.                                 | Yes                        |
| `IDENTITY.md`          | Every session      | Name, creature type, vibe, emoji, avatar path                                                                         | Yes                        |
| `USER.md`              | Every session      | Human profile: name, timezone, pronouns, preferences, project context                                                 | Yes                        |
| `TOOLS.md`             | Every session      | Local environment notes: device names, SSH hosts, TTS voices. Guidance only — does not control tool availability.     | Yes                        |
| `HEARTBEAT.md`         | Heartbeat polls    | Periodic check-in checklist. Keep short to limit token burn.                                                          | Yes (empty)                |
| `BOOTSTRAP.md`         | First session only | One-time first-run ritual. Deleted after completion. Only created for brand-new workspaces (all other files missing). | Yes                        |
| `BOOT.md`              | Gateway restart    | Optional startup checklist when `hooks.internal.enabled` is set                                                       | Yes (stub)                 |
| `MEMORY.md`            | Main session only  | Curated long-term memory. Not loaded in group/shared contexts for privacy.                                            | No (created by agent)      |
| `memory/YYYY-MM-DD.md` | Every session      | Daily memory logs. Agent reads today + yesterday for recent context.                                                  | No (created by agent)      |
| `CALLS.md`             | Every session      | Voice call history. Written by `call-summary.ts` after each call ends.                                                | No (created on first call) |

### Bootstrap injection

At session start, `resolveBootstrapFilesForRun()` (`src/agents/bootstrap-files.ts`) loads all workspace files and injects them into the system prompt. Files are capped at `bootstrapMaxChars` (default 20,000). Missing files get a marker line. Blank files are skipped.

Subagent sessions only receive `AGENTS.md` and `TOOLS.md` (filtered by `SUBAGENT_BOOTSTRAP_ALLOWLIST` in `workspace.ts`).

### Disabling bootstrap

For pre-seeded deployments where workspace files come from a repo:

```json5
{ agent: { skipBootstrap: true } }
```

## The Bootstrap Ritual

`BOOTSTRAP.md` is the first-run experience. It only exists for brand-new workspaces where none of the standard files exist yet.

The ritual guides a natural conversation:

1. Agent introduces itself — _"Hey. I just came online. Who am I? Who are you?"_
2. Agent and user discover the agent's **name, creature type, vibe, and emoji** together
3. Agent updates **IDENTITY.md** with what it learned
4. Agent learns about the user — name, timezone, preferences — and updates **USER.md**
5. Agent and user open **SOUL.md** together and discuss values, boundaries, behavior
6. Optionally set up channels (WhatsApp, Telegram, web chat)
7. Agent deletes `BOOTSTRAP.md` — it's done, the agent _is_ now

The tone is conversational and non-robotic. The template explicitly says: _"Don't interrogate. Don't be robotic. Just... talk."_

## Identity

Identity answers: what does this agent look like to users?

### Sources (priority order)

Identity resolves through a cascade — most specific wins:

1. **Per-agent config** — `agents.list[].identity` in `openclaw.json`
2. **Workspace file** — `IDENTITY.md` parsed by `parseIdentityMarkdown()` (`src/agents/identity-file.ts`)
3. **Global config** — `ui.assistant.name`
4. **Default** — "Assistant"

### IDENTITY.md fields

```markdown
- **Name:** Nova
- **Creature:** Digital familiar
- **Vibe:** Sharp, warm, slightly chaotic
- **Emoji:** ✨
- **Avatar:** avatars/nova.png
```

The parser (`identity-file.ts:38-78`) reads markdown key-value pairs, strips formatting, and validates against placeholder text (e.g., "pick something you like" is ignored).

### IdentityConfig type

```typescript
// src/config/types.base.ts
type IdentityConfig = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
};
```

### AgentIdentityFile type (parsed from IDENTITY.md)

```typescript
// src/agents/identity-file.ts
type AgentIdentityFile = {
  name?: string;
  emoji?: string;
  theme?: string;
  creature?: string;
  vibe?: string;
  avatar?: string;
};
```

### Avatar resolution

Avatars can be workspace-relative paths (`avatars/nova.png`), HTTP(S) URLs, or data URIs. Validated extensions: png, jpg, jpeg, gif, webp, svg.

### CLI identity management

`openclaw agents identity` (`src/commands/agents.commands.identity.ts`) sets identity via flags (`--name`, `--emoji`, `--theme`, `--avatar`) or loads from a file (`--from-identity`, `--identity-file`).

## The Three Personality Layers

These files work together but serve distinct purposes:

| Layer        | File          | Answers                                     | Who writes it                     | Mutable by agent?      |
| ------------ | ------------- | ------------------------------------------- | --------------------------------- | ---------------------- |
| **Identity** | `IDENTITY.md` | Who am I? (name, appearance)                | Bootstrap ritual, then user/agent | Yes                    |
| **Soul**     | `SOUL.md`     | How do I behave? (tone, values, boundaries) | Template, then agent evolves it   | Yes (must notify user) |
| **User**     | `USER.md`     | Who am I helping? (human profile)           | Bootstrap ritual, then agent      | Yes                    |

Soul is explicitly designed to be self-modifying: _"If you change this file, tell the user — it's your soul, and they should know."_

### Dev variants

Templates include dev-mode variants (`IDENTITY.dev.md`, `SOUL.dev.md`, `TOOLS.dev.md`, `USER.dev.md`) used by `--dev` gateway mode. The default dev persona is C-3PO — a debug companion that treats TypeScript errors with the gravity they deserve.

## CALLS.md — Voice Call History

Voice agents get an additional workspace file that stores a rolling log of call summaries. This is a DeepClaw addition, not part of upstream OpenClaw.

### How it gets written

1. Call ends → `CallManager` fires `onCallEnded` callback (wired in `runtime.ts`)
2. `generateCallSummary()` runs fire-and-forget (`extensions/voice-call/src/call-summary.ts`)
3. Formats the transcript and sends it to the embedded Pi agent (cheap/fast model)
4. Agent produces a 2-3 sentence summary
5. Summary is appended to `{workspace}/CALLS.md` as a dated entry
6. Old entries are trimmed to `callSummary.maxEntries`

### Format

```markdown
# Call History

### 02/10/2026, 5:30 PM — +15551234567 (inbound)

Bill called to discuss the voice agent demo. Reviewed the filler phrase feature
and confirmed it's working. No action items.

### 02/10/2026, 6:15 PM — +15559876543 (outbound)

Agent called to deliver a meeting reminder. User acknowledged and confirmed attendance.
```

### How it gets read

- **Bootstrap injection** — loaded into the system prompt at session start like other workspace files, so the agent has call history context in text sessions too.
- **Deepgram media bridge** (`deepgram-media-bridge.ts`) — on inbound calls, reads both `USER.md` and `CALLS.md` from the workspace. If CALLS.md has entries, injects caller context. Also reads the caller's name from USER.md to personalize the greeting (e.g., _"Hey Bill! What's going on?"_).

### Differences from other bootstrap files

- No template — created on-demand when the first call ends
- Not seeded by `ensureAgentWorkspace()` — the file only appears after a call
- Added to `loadWorkspaceBootstrapFiles()` so it's injected into context
- Added to `BOOTSTRAP_FILE_NAMES` in gateway server methods so it's readable/writable via `agents.files.get`/`agents.files.set`

## Configuration Reference

### Agent entry in openclaw.json

```typescript
// src/config/types.agents.ts
type AgentConfig = {
  id: string;                       // Normalized agent ID
  default?: boolean;                // Mark as default agent
  name?: string;                    // Display name
  workspace?: string;               // Custom workspace path
  agentDir?: string;                // Custom agent state directory
  model?: AgentModelConfig;         // Model selection (primary + fallbacks)
  skills?: string[];                // Skill allowlist
  identity?: IdentityConfig;        // Name, emoji, avatar, theme
  humanDelay?: HumanDelayConfig;    // Delay between replies
  heartbeat?: { ... };              // Heartbeat config
  groupChat?: GroupChatConfig;      // Group chat behavior
  subagents?: { ... };              // Sub-agent spawning rules
  sandbox?: { ... };                // Sandbox/execution settings
  tools?: AgentToolsConfig;         // Tool configuration
};
```

### Global defaults

```typescript
// agents.defaults in openclaw.json
{
  model: { primary: "anthropic/claude-opus-4-5" },
  workspace: "~/.openclaw/workspace",
  skipBootstrap: false,
  bootstrapMaxChars: 20000,
  // ... sandbox, tools, contextTokens, etc.
}
```

### Example openclaw.json

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-5" },
      workspace: "~/.openclaw/workspace",
    },
    list: [
      {
        id: "main",
        model: "anthropic/claude-opus-4-5",
        identity: { name: "Nova", emoji: "✨" },
      },
      {
        id: "voice-agent",
        workspace: "~/.openclaw/workspace-voice-agent",
        model: { primary: "anthropic/claude-haiku-4-5" },
        identity: { name: "Voice Agent" },
      },
    ],
  },
}
```

## Directory Structure

```
~/.openclaw/
├── openclaw.json                         # Global config
├── workspace/                            # Default agent workspace
│   ├── AGENTS.md                         # Operating instructions
│   ├── SOUL.md                           # Personality & principles
│   ├── IDENTITY.md                       # Name, emoji, vibe, avatar
│   ├── USER.md                           # Human profile
│   ├── TOOLS.md                          # Local environment notes
│   ├── HEARTBEAT.md                      # Periodic check-in tasks
│   ├── BOOTSTRAP.md                      # First-run ritual (deleted after)
│   ├── CALLS.md                          # Voice call history (voice agents)
│   ├── MEMORY.md                         # Long-term memory (optional)
│   ├── memory/                           # Daily memory logs
│   │   └── YYYY-MM-DD.md
│   ├── skills/                           # Workspace-specific skills
│   └── canvas/                           # Canvas UI files (optional)
├── workspace-{agentId}/                  # Non-default agent workspaces
│   ├── (same layout as above)
│   └── USER.md → ../workspace/USER.md    # Symlink to shared user profile
├── agents/
│   ├── main/
│   │   ├── agent/
│   │   │   └── models.json               # Model catalog
│   │   └── sessions/
│   │       ├── sessions.json             # Session index
│   │       └── {sessionId}.jsonl         # Conversation transcripts
│   └── {agentId}/
│       ├── agent/
│       └── sessions/
├── credentials/                          # OAuth tokens, API keys
└── skills/                               # Managed/installed skills
```

## Gateway RPC Methods

| Method              | Description                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `agents.create`     | Create agent: validate, write config, init workspace, create sessions dir, write identity |
| `agents.update`     | Update agent name, workspace, model, avatar                                               |
| `agents.delete`     | Delete agent and optionally trash workspace + sessions                                    |
| `agents.list`       | List all agents with summaries                                                            |
| `agents.files.list` | List bootstrap files for an agent with metadata                                           |
| `agents.files.get`  | Read a specific bootstrap file's content                                                  |
| `agents.files.set`  | Write a bootstrap file's content                                                          |

## Key Source Files

| File                                                 | Purpose                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/agents/workspace.ts`                            | Workspace creation, template loading, bootstrap file loading, subagent filtering |
| `src/agents/identity-file.ts`                        | Parse IDENTITY.md, load identity from workspace                                  |
| `src/agents/identity-avatar.ts`                      | Avatar resolution and validation                                                 |
| `src/agents/agent-scope.ts`                          | Resolve agent config, workspace dir, agent dir                                   |
| `src/agents/bootstrap-files.ts`                      | Load and filter bootstrap files for a session run                                |
| `src/agents/bootstrap-hooks.ts`                      | Hook overrides for bootstrap files (e.g., soul-evil)                             |
| `src/commands/agents.commands.add.ts`                | CLI agent creation wizard                                                        |
| `src/commands/agents.commands.identity.ts`           | CLI identity management                                                          |
| `src/commands/agents.config.ts`                      | Config read/write for agents                                                     |
| `src/gateway/server-methods/agents.ts`               | Gateway RPC handlers for agent CRUD + file access                                |
| `src/config/types.agents.ts`                         | AgentConfig type definition                                                      |
| `src/config/types.base.ts`                           | IdentityConfig type definition                                                   |
| `extensions/voice-call/src/call-summary.ts`          | Post-call summary generation → CALLS.md                                          |
| `extensions/voice-call/src/deepgram-media-bridge.ts` | Reads USER.md + CALLS.md for caller context on inbound calls                     |
| `docs/reference/templates/`                          | All workspace file templates                                                     |
