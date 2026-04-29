import { EventEmitter } from "node:events";
import path from "node:path";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";
import { appendLog, ensureDir, getPokePaths, readConfig } from "@poke/storage";
import { receiveMessage } from "./index.js";
const pairingEvents = new EventEmitter();
const pairingMaterials = new Map();
const PAIRING_TTL_MS = 5 * 60 * 1000;
export async function createWhatsAppRuntime() {
    const paths = getPokePaths();
    const config = readConfig(paths);
    ensureDir(paths.whatsapp);
    const authDir = path.join(paths.whatsapp, "auth");
    ensureDir(authDir);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const adapter = createBaileysAdapter({
        adapterName: "poke-whatsapp",
        userName: "Poke",
        auth: { state, saveCreds },
        phoneNumber: config.channels.whatsapp.allowedNumber?.replace(/[^\d]/g, ""),
        onPairingCode: (code) => {
            storePairingMaterial("pairing_code", code);
            appendLog("info", "whatsapp.pairing_required");
        },
        onQR: (qr) => {
            storePairingMaterial("qr", qr);
            appendLog("info", "whatsapp.pairing_required");
        }
    });
    const bot = new Chat({
        userName: "Poke",
        adapters: { whatsapp: adapter },
        state: createMemoryState()
    });
    bot.onNewMessage(/.+/, async (thread, message) => {
        if (!thread.isDM || message.author.isMe)
            return;
        const text = typeof message.text === "string" ? message.text.trim() : "";
        const hasMedia = Boolean(message.media)
            || Boolean(message.hasMedia)
            || Boolean(message.attachments?.length);
        if (!text && hasMedia)
            return;
        if (!text)
            return;
        const result = await receiveMessage({
            channel: "whatsapp",
            content: text,
            from: message.author.userId
        });
        if (result.responseMessage?.content)
            await thread.post(result.responseMessage.content);
    });
    await bot.initialize();
    return {
        connect: () => adapter.connect(),
        disconnect: () => adapter.disconnect()
    };
}
export function getWhatsAppPairingMaterial() {
    return Array.from(pairingMaterials.values());
}
export function onWhatsAppPairingMaterial(listener) {
    pairingEvents.on("pairing", listener);
    return () => pairingEvents.off("pairing", listener);
}
function storePairingMaterial(kind, value) {
    const now = Date.now();
    const entry = {
        kind,
        value,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PAIRING_TTL_MS).toISOString()
    };
    pairingMaterials.set(kind, entry);
    pairingEvents.emit("pairing", entry);
    const timer = setTimeout(() => {
        const current = pairingMaterials.get(kind);
        if (current?.expiresAt === entry.expiresAt) {
            pairingMaterials.delete(kind);
        }
    }, PAIRING_TTL_MS);
    timer.unref?.();
}
//# sourceMappingURL=whatsapp.js.map