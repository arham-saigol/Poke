import crypto from "node:crypto";
import fs from "node:fs";
import { activeSessionSchema, type ActiveSession, type Channel, type ChatMessage, type ReasoningLevel } from "@poke/shared";
import { appendLog, audit, bootstrapPokeHome, getPokePaths, readConfig, writeJson } from "@poke/storage";

export type IncomingMessageInput = {
  channel: Exclude<Channel, "system">;
  content: string;
  mediaPath?: string;
  from?: string;
};

export type MessageResult = {
  session: ActiveSession;
  responseMessage: ChatMessage | null;
};

export function getActiveSession(): ActiveSession {
  const paths = bootstrapPokeHome();
  if (!fs.existsSync(paths.session)) {
    const now = new Date().toISOString();
    const session: ActiveSession = {
      id: crypto.randomUUID(),
      reasoning: "low",
      status: "idle",
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    writeSession(session);
    return session;
  }
  return activeSessionSchema.parse(JSON.parse(fs.readFileSync(paths.session, "utf8")));
}

export function newSession(): ActiveSession {
  const now = new Date().toISOString();
  const session: ActiveSession = {
    id: crypto.randomUUID(),
    reasoning: "low",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    messages: [
      message("system", "system", "Started a new Poke session.", undefined, crypto.randomUUID())
    ]
  };
  writeSession(session);
  audit("session.new", session.id);
  return session;
}

export async function receiveMessage(input: IncomingMessageInput): Promise<MessageResult> {
  if (input.channel === "whatsapp") {
    assertAllowedWhatsAppSender(input.from);
  }
  if (input.content.trim().startsWith("/")) {
    const session = handleSlashCommand(input.content.trim(), input.channel);
    const responseMessage = session.messages[session.messages.length - 1] ?? null;
    return { session, responseMessage };
  }
  const session = getActiveSession();
  session.status = "running";
  session.messages.push(message("user", input.channel, input.content, input.mediaPath, session.id));
  session.updatedAt = new Date().toISOString();
  
  // Persist session immediately after adding user message and setting status
  writeSession(session);
  
  try {
    const loadRuntime = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
    const { parentTools } = await loadRuntime("@poke/agent-runtime");
    const child = await parentTools.ask_poke({ task: input.content, reasoning: session.reasoning });
    const responseMessage = message("assistant", input.channel, child.output, undefined, session.id);
    session.messages.push(responseMessage);
    session.status = "idle";
    session.updatedAt = new Date().toISOString();
    writeSession(session);
    appendLog("info", "channel.message.processed", { channel: input.channel, sessionId: session.id });
    return { session, responseMessage };
  } catch (error) {
    // Update session status on error and persist
    session.status = "idle";
    session.updatedAt = new Date().toISOString();
    session.messages.push(message("system", "system", `Error processing message: ${String(error)}`, undefined, session.id));
    writeSession(session);
    throw error;
  }
}

export function handleSlashCommand(command: string, channel: Channel): ActiveSession {
  const [name, arg] = command.split(/\s+/, 2);
  if (name === "/new") return newSession();
  const session = getActiveSession();
  if (name === "/abort") {
    session.status = "aborted";
    session.messages.push(message("system", "system", "Current Poke activity was aborted.", undefined, session.id));
    audit("session.abort", session.id, { channel });
  } else if (name === "/reasoning") {
    const level = parseReasoning(arg);
    session.reasoning = level;
    session.messages.push(message("system", "system", `Parent reasoning set to ${level}.`, undefined, session.id));
    audit("session.reasoning", session.id, { level, channel });
  } else if (name === "/restart") {
    session.messages.push(message("system", "system", "Daemon restart requested. Use `poke restart` on the host to perform the restart in this scaffold.", undefined, session.id));
    audit("daemon.restart.requested", session.id, { channel });
  } else {
    session.messages.push(message("system", "system", `Unknown slash command: ${name}`, undefined, session.id));
  }
  session.updatedAt = new Date().toISOString();
  writeSession(session);
  return session;
}

export function writeSession(session: ActiveSession): void {
  const paths = bootstrapPokeHome();
  writeJson(paths.session, activeSessionSchema.parse(session));
}

export function getWhatsAppStatus(): {
  enabled: boolean;
  adapter: "baileys";
  allowedNumber: string | null;
  connected: boolean;
  instructions: string;
} {
  const config = readConfig();
  return {
    enabled: config.channels.whatsapp.enabled,
    adapter: config.channels.whatsapp.adapter,
    allowedNumber: config.channels.whatsapp.allowedNumber,
    connected: false,
    instructions:
      "Baileys transport is installed. Start the gateway with POKE_ENABLE_WHATSAPP=1 after setting an allowed WhatsApp number; pairing codes and QR strings are written to gateway logs."
  };
}

function assertAllowedWhatsAppSender(from?: string): void {
  const config = readConfig();
  const allowed = config.channels.whatsapp.allowedNumber;
  
  // If an allowlist is configured, reject messages without a sender or from non-allowed senders
  if (allowed) {
    if (!from) {
      audit("whatsapp.message.rejected", "unknown");
      throw new Error("WhatsApp sender is not allowed.");
    }
    if (normalizePhone(from) !== normalizePhone(allowed)) {
      audit("whatsapp.message.rejected", from);
      throw new Error("WhatsApp sender is not allowed.");
    }
  }
}

function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "");
}

function parseReasoning(value?: string): ReasoningLevel {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "low";
}

function message(role: ChatMessage["role"], channel: Channel, content: string, mediaPath: string | undefined, sessionId: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    sessionId,
    role,
    channel,
    content,
    mediaPath,
    createdAt: new Date().toISOString()
  };
}
