# Poke

Poke is a personal agent runtime designed to run on a user's own VPS.

This repository currently contains Block 1 of the implementation plan:

- shared schemas
- local storage bootstrap
- encrypted secrets store
- daemon gateway skeleton
- CLI lifecycle commands
- setup wizard foundation
- doctor checks
- update and backup plumbing

## Local commands

```bash
pnpm install
pnpm build
pnpm poke -- help
pnpm poke-doctor
```
