# Architecture

Poke is a single-user VPS agent runtime. The daemon owns channel ingress, the shared active session, slash commands, and agent orchestration. The web app reads and mutates the same local Poke home as the daemon.

Core packages:

- `@poke/storage`: config, encrypted secrets, SQLite, logs, audit events, backups.
- `@poke/channels`: shared session and web/WhatsApp message normalization.
- `@poke/agent-runtime`: parent/child tool boundary and runtime prompts.
- `@poke/memory`: file-backed memory and cleanup reports.
- `@poke/skills`: skill discovery and bundled skills.
- `@poke/connectors`: progressive connector disclosure.
- `@poke/automations`: automation validation and execution scaffold.

Poke home defaults to `~/.poke` and can be overridden with `POKE_HOME`.
