import path from "node:path";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";
import { appendLog, ensureDir, getPokePaths, readConfig } from "@poke/storage";
import { receiveMessage } from "./index.js";

export type WhatsAppRuntime = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};

export async function createWhatsAppRuntime(): Promise<WhatsAppRuntime> {
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
    onPairingCode: (code) => appendLog("info", "whatsapp.pairing_code", { code }),
    onQR: (qr) => appendLog("info", "whatsapp.qr", { qr })
  });
  const bot = new Chat({
    userName: "Poke",
    adapters: { whatsapp: adapter },
    state: createMemoryState()
  });
  bot.onNewMessage(/.+/, async (thread, message) => {
    if (!thread.isDM || message.author.isMe) return;
    const session = await receiveMessage({
      channel: "whatsapp",
      content: message.text ?? "",
      from: message.author.userId
    });
    const reply = [...session.messages].reverse().find((item) => item.role === "assistant");
    if (reply?.content) await thread.post(reply.content);
  });
  await bot.initialize();
  return {
    connect: () => adapter.connect(),
    disconnect: () => adapter.disconnect()
  };
}
