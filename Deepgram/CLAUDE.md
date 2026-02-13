# Sharpclaw

Combined Twilio proxy + OpenClaw gateway deployed as a single container on Fly.io.

## Architecture

- **OpenClaw gateway** (Node.js) runs in the background on port 18789 (internal only)
- **Twilio proxy** (Python/FastAPI/uvicorn) runs in the foreground on port 8000 (externally exposed on 443)
- `/v1/chat/completions` is reverse-proxied through FastAPI to OpenClaw on localhost
- Deepgram Voice Agent's "think" provider points at the public Fly URL with `fly-force-instance-id` for machine pinning
- SMS messages are routed through OpenClaw with date-based session keys (`agent:{id}:sms-YYYYMMDD`)
- Voice calls get unique 12-char hex call IDs for isolated sessions (`agent:{id}:{call_id}`)
- Outbound calls get `outbound-{hex}` session IDs — the callee is a different person, so sessions are fully isolated
- After each inbound call ends, a post-call hook asks OpenClaw to generate a greeting for the next call, written to `~/.openclaw/workspace/NEXT_GREETING.txt`
- Deepgram-side voice prompts contain only TTS formatting rules; personality/tone comes from OpenClaw's own files (AGENTS.md, USER.md)
- OpenClaw skills (in `home/.openclaw/skills/`) are seeded into the container on every startup

## Key Files

- `Dockerfile` — Combined image: OpenClaw base + Python/uv + Twilio app
- `entrypoint.sh` — Resolves config template via `envsubst`, starts OpenClaw bg, waits for TCP ready, execs uvicorn
- `fly.toml` — Single Fly service on port 8000/443
- `launch.sh` — Creates Fly app, creates volume, deploys
- `deepclaw_deploy.sh` — CI/CD: builds image with git tag, deploys, sets `OPENCLAW_IMAGE` secret on control plane
- `update_machines.sh` — Updates all Fly machines to a given image tag
- `home/.openclaw/openclaw.json` — OpenClaw config template (env vars resolved by `envsubst` on each startup)
- `home/.openclaw/skills/twilio-actions/SKILL.md` — OpenClaw skill: teaches agent to send SMS and make calls
- `deepgram_handler/` — Python FastAPI app (Twilio webhooks, Deepgram bridge, OpenClaw proxy)

## Deepgram Handler App Structure

- `deepgram_handler/app/config.py` — Settings via pydantic-settings (env vars)
- `deepgram_handler/app/main.py` — FastAPI app with routers + `/health` endpoint
- `deepgram_handler/app/routers/voice.py` — Twilio inbound/outbound voice webhooks + WebSocket media streams
- `deepgram_handler/app/routers/sms.py` — Twilio inbound SMS → OpenClaw → TwiML reply
- `deepgram_handler/app/routers/proxy.py` — Control plane SMS proxy: receives forwarded Twilio SMS, returns JSON
- `deepgram_handler/app/routers/openclaw_proxy.py` — Reverse proxy /v1/chat/completions to localhost:18789
- `deepgram_handler/app/routers/actions.py` — Agent action endpoints: POST /actions/send-sms, POST /actions/make-call
- `deepgram_handler/app/services/deepgram_agent.py` — Deepgram Voice Agent WebSocket bridge + config builder
- `deepgram_handler/app/services/twilio_media.py` — Twilio media stream protocol helpers
- `deepgram_handler/app/services/outbound_sms.py` — Outbound SMS via deepclaw-control proxy
- `deepgram_handler/app/services/outbound_call.py` — Outbound voice calls via deepclaw-control proxy

## Running Tests

```bash
cd deepgram_handler && uv run pytest tests/ -v
```

## Deploying

1. Fill in `.env` with `DEEPGRAM_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `ANTHROPIC_API_KEY`
2. Run `./launch.sh` (first deploy creates app, volume, deploys)
3. Subsequent deploys: `fly deploy --app deepclaw-instance --config fly.toml`
4. CI/CD deploy: `./deepclaw_deploy.sh` (builds, deploys, updates control plane)
5. Update existing machines to a tag: `./update_machines.sh <tag>`

## Fly Secrets

- `DEEPGRAM_API_KEY` — For Deepgram Voice Agent
- `OPENCLAW_GATEWAY_TOKEN` — Auth token for OpenClaw gateway
- `ANTHROPIC_API_KEY` — For OpenClaw to call Claude

## Twilio Webhooks

- Voice (inbound): `https://deepclaw-instance.fly.dev/twilio/inbound`
- Voice (outbound callback): `https://deepclaw-instance.fly.dev/twilio/outbound?sid={session_id}`
- SMS: `https://deepclaw-instance.fly.dev/twilio/inbound-sms`
- Control plane SMS proxy: `https://deepclaw-instance.fly.dev/proxy/inbound-sms`

## Container Details

- Base image runs as `node` user — Dockerfile switches to `root` for apt/install, back to `node` for runtime
- `UV_PYTHON_INSTALL_DIR=/opt/python` so uv's Python is accessible to `node` user
- Entrypoint uses Node's `net.connect` for TCP health check (not wget — OpenClaw is a WS server)
- Config template is resolved via `envsubst` on every startup (env vars change when pool machines are claimed)
- Persistent volume mounted at `/home/node` stores OpenClaw workspace and config

## Design Docs

- `docs/plans/2026-02-13-combined-container-design.md` — Architecture design
- `docs/plans/2026-02-13-combined-container-plan.md` — Implementation plan
- `docs/plans/2026-02-13-dynamic-greetings-design.md` — Dynamic greetings design
- `docs/plans/2026-02-13-dynamic-greetings-plan.md` — Dynamic greetings implementation plan
