# WhatsApp

The channel layer exposes `receiveMessage({ channel: "whatsapp", ... })` and rejects senders that do not match the configured allowed number.

The Baileys adapter wiring pass should:

- Store Baileys auth under `~/.poke/whatsapp`.
- Normalize incoming WhatsApp messages into `receiveMessage`.
- Route agent replies through the channel send path.
- Keep the transport swappable behind the same channel boundary.

The current implementation includes status and security scaffolding, not live pairing.
