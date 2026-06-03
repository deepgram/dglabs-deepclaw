---
name: lobster
description: "Execute multi-step deterministic workflows with approval checkpoints via the Lobster pipeline engine. Use when the user wants repeatable automations (email triage, monitoring, syncing), actions that need human approval before executing, or multiple tool calls as one deterministic operation."
---

# Lobster

Execute multi-step workflows with approval checkpoints.

## When to use

- Repeatable automations (triage, monitor, sync)
- Actions needing human approval before executing (send, post, delete)
- Multiple tool calls as one deterministic operation

Do NOT use for single-action requests, queries needing LLM interpretation mid-flow, or one-off tasks.

## Run a pipeline

```json
{"action": "run", "pipeline": "gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage"}
```

Returns JSON with `protocolVersion`, `ok`, `status`, `output`, and `requiresApproval`.

## Handle approval

When `status` is `needs_approval`, present the `requiresApproval.prompt` to the user. If approved:

```json
{"action": "resume", "token": "<resumeToken>", "approve": true}
```

## Example pipelines

- Email triage: `gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage`
- With approval gate: `gog.gmail.search --query 'newer_than:1d' | email.triage | approve --prompt 'Process these?'`

## Key behaviors

- Deterministic: same input produces same output (no LLM variance)
- Approval gates halt execution and return a resume token
- Structured output: always JSON envelope with `protocolVersion`
