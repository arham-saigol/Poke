# Security

Poke is designed for a single trusted owner on a VPS.

Implemented hardening:

- Path traversal protection through `safeResolve`.
- Encrypted local secrets in `secrets.enc.json`.
- Structured logs with metadata redaction for keys, tokens, credentials, secrets, and passwords.
- Audit events for sensitive operations.
- Backup creation before restore/update/memory cleanup.
- Gateway body-size limit and basic per-minute local rate limit.
- Web security headers through Next.js.
- WhatsApp allowed-number enforcement in the channel layer.
- Basic shell denylist for clearly destructive commands.

Cloudflare Access should be enabled in front of the web app for production exposure.
