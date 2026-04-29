# Setup

Recommended VPS baseline:

- Ubuntu 22.04 or 24.04
- Node.js 22 or newer
- pnpm
- cloudflared
- yt-dlp and ffmpeg for media transcription

Run:

```bash
pnpm install
pnpm build
pnpm poke setup
pnpm poke-doctor
pnpm poke start
```

For headless Cloudflare login, run `cloudflared tunnel login` on the VPS and open the printed URL on your local machine.
