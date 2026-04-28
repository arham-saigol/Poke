# Poke

Poke is a personal agent runtime designed to run on your own VPS. It exposes a parent/child agent architecture over a local HTTP gateway, with a Next.js web UI, WhatsApp channel support, a skills system, scheduled automations, and a CLI for day-to-day operations.

> **Status:** Core implementation is in place across all four blocks. Several areas still need review, wiring, and hardening before this is production-ready.

## Architecture

```
apps/
  gateway/   — HTTP daemon (port 43210), agent message routing, WhatsApp runtime
  web/       — Next.js UI with API routes for session, automations, connectors, settings

packages/
  shared/        — Zod schemas shared across packages (config, sessions, tools, automations)
  storage/       — Encrypted secrets store, SQLite DB + migrations, backup/restore, audit log
  agent-runtime/ — Parent/child agent tool definitions and system prompts
  memory/        — Markdown memory files with YAML frontmatter, category index, cleanup pipeline
  automations/   — Automation loader, scheduler, and command/prompt runner
  channels/      — Session management, message routing, slash commands, WhatsApp via Baileys
  connectors/    — Connector registry (GitHub, Notion, PostHog, AgentMail), credential storage
  skills/        — Skill loader (SKILL.md format, enabled/disabled folders, bundled skills)
  cli/           — `poke` daemon CLI (setup, start, stop, restart, status, logs, backup, update)
  doctor/        — `poke-doctor` pre-flight health checks
```

## What's implemented

### Foundation (Block 1)
- Shared Zod schemas for config, automations, sessions, tool names, and connectors
- Local storage bootstrap: directory layout, `config.json`, `automations.json`, memory index
- AES-256-GCM encrypted secrets store (`secrets.enc.json`), keyed from env or machine identity
- SQLite database with schema migrations (`daemon_events`, `automation_runs`, `audit_events`)
- Structured JSON logging and audit trail
- `poke` CLI: `setup`, `start`, `stop`, `restart`, `status`, `logs`, `memory cleanup`, `backup create/list/restore`, `update`
- `poke-doctor` health checks: Node.js ≥ 22, pnpm, SQLite, cloudflared, yt-dlp, ffmpeg, optional API keys

### Memory & Agent Runtime (Block 2)
- Markdown memory files with YAML frontmatter (title, category, updatedAt), category-based index auto-rebuilt on write/delete
- Memory cleanup pipeline with backup, consolidator/advisory/judge reports
- Parent agent tools: `get_index`, `read_memory`, `write_memory`, `delete_memory`, `ask_poke`, `send_message`
- Child agent tools: `read`, `write`, `edit`, `bash` (with blocked-command safety policy), `web_search` (Exa), `web_fetch`, `deep_research`, `generate_image` (Vercel AI Gateway), `edit_image`, `transcribe_audio` (Deepgram + yt-dlp)
- Connector disclosure tools: `use_github`, `use_notion`, `use_posthog`, `use_agentmail`

### Channels & Connectors (Block 3)
- Session model: per-session message history, reasoning level, idle/running/aborted status
- Slash commands: `/new`, `/abort`, `/reasoning <level>`, `/restart`
- WhatsApp channel via Baileys adapter with allowed-number allowlist
- Connector registry: GitHub (OAuth), Notion (OAuth), PostHog (API key), AgentMail (API key)
- Connector connect/enable/disable with credential storage; tool disclosure gated on enabled state
- Skills system: SKILL.md format, enabled/disabled folder swap, bundled `skill-creator` and `poke` skills

### Gateway & Web UI (Block 4)
- HTTP gateway on `127.0.0.1:43210` with per-IP rate limiting (120 req/min) and graceful shutdown
- Gateway endpoints: `GET /health`, `GET /runtime`, `GET /status`, `GET /automations`, `GET /session`, `POST /message`, `POST /whatsapp/inbound`
- Next.js web app with API routes: session, automations, connectors, files, settings, status, whatsapp
- Automation runner for `command` and `prompt` action types
- systemd service unit at `deploy/poke.service`

## Local setup

```bash
pnpm install
pnpm build

# First-time bootstrap
pnpm poke -- setup

# Health check
pnpm poke-doctor

# Start the daemon
pnpm poke -- start

# Start the web UI (separate terminal)
cd apps/web && pnpm dev
```

## Runtime data

Poke stores all runtime state in `~/.poke/` (or `$POKE_HOME`). This directory is excluded from git — it contains machine-specific config, encrypted secrets, the SQLite database, logs, memory files, and skill definitions.

## Configuration

Model providers, channel settings, and the public base URL are set in `~/.poke/config.json` after running `poke setup`. API keys and connector credentials are stored encrypted via `poke`'s secrets store and never written to the config file in plaintext.
