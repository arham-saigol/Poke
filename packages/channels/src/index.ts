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

const ACTIVE_SESSION_LOCK = "active-session";
const sessionQueues = new Map<string, Promise<unknown>>();
const runningRequests = new Map<string, Set<AbortController>>();

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
    const session = await handleSlashCommand(input.content.trim(), input.channel);
    const responseMessage = session.messages[session.messages.length - 1] ?? null;
    return { session, responseMessage };
  }
  const { result } = await mutateActiveSession((current) => {
    current.status = "running";
    current.messages.push(message("user", input.channel, input.content, input.mediaPath, current.id));
    return { reasoning: current.reasoning, sessionId: current.id };
  });
  const controller = new AbortController();
  registerRunningRequest(result.sessionId, controller);

  try {
    const { parentTools } = await import("@poke/agent-runtime");
    const child = await parentTools.ask_poke({ task: input.content, reasoning: result.reasoning, signal: controller.signal });
    unregisterRunningRequest(result.sessionId, controller);
    const responseMessage = message("assistant", input.channel, child.output, undefined, result.sessionId);
    const completion = await mutateActiveSession((current) => {
      if (current.id !== result.sessionId || controller.signal.aborted || current.status === "aborted") {
        return { responseMessage: null as ChatMessage | null, shouldLog: false };
      }
      current.messages.push(responseMessage);
      current.status = "idle";
      return { responseMessage, shouldLog: true };
    });
    if (completion.result.shouldLog) {
      appendLog("info", "channel.message.processed", { channel: input.channel, sessionId: result.sessionId });
    }
    return { session: completion.session, responseMessage: completion.result.responseMessage };
  } catch (error) {
    unregisterRunningRequest(result.sessionId, controller);
    if (controller.signal.aborted) {
      const aborted = getActiveSession();
      return { session: aborted, responseMessage: null };
    }
    await mutateActiveSession((current) => {
      if (current.id !== result.sessionId) {
        return;
      }
      current.status = "idle";
      current.messages.push(message("system", "system", `Error processing message: ${String(error)}`, undefined, current.id));
    });
    throw error;
  }
}

export async function handleSlashCommand(command: string, channel: Channel): Promise<ActiveSession> {
  const [name, arg] = command.split(/\s+/, 2);
  if (name === "/new") {
    // Create the new session inside the same lock the other slash-command mutations
    // use so the rotation is atomic with respect to concurrent reads/writes. We use
    // withSessionLock directly (rather than mutateActiveSession) because the latter
    // re-writes the previous session on the way out, which would clobber the freshly
    // created one.
    return await withSessionLock(ACTIVE_SESSION_LOCK, async () => newSession());
  }
  const { session } = await mutateActiveSession(async (current) => {
    if (name === "/abort") {
      current.status = "aborted";
      current.messages.push(message("system", "system", "Current Poke activity was aborted.", undefined, current.id));
      audit("session.abort", current.id, { channel });
      abortRunningRequests(current.id);
      return;
    }
    if (name === "/reasoning") {
      const level = parseReasoning(arg);
      current.reasoning = level;
      current.messages.push(message("system", "system", `Parent reasoning set to ${level}.`, undefined, current.id));
      audit("session.reasoning", current.id, { level, channel });
      return;
    }
    if (name === "/restart") {
      // TODO: Implement an actual daemon restart hand-off here. The /restart slash command
      // is intentional scaffolding: it records the user's intent (system message + audit
      // event) but does not signal the gateway/daemon to relaunch. Wiring this up requires
      // an out-of-band channel to the supervisor (e.g. a restart helper that runs
      // abortRunningRequests, persists state, and invokes `poke restart` or sends SIGTERM
      // to the gateway PID). Until that exists, the user is directed to run `poke restart`
      // on the host.
      current.messages.push(message("system", "system", "Daemon restart requested. Use `poke restart` on the host to perform the restart in this scaffold.", undefined, current.id));
      audit("daemon.restart.requested", current.id, { channel });
      return;
    }
    current.messages.push(message("system", "system", `Unknown slash command: ${name}`, undefined, current.id));
  });
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
      "Baileys transport is installed. Start the gateway with POKE_ENABLE_WHATSAPP=1 after setting an allowed WhatsApp number; pairing material is kept in memory instead of gateway logs."
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
  return value.replace(/\D/g, "");
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

async function mutateActiveSession<T>(mutate: (session: ActiveSession) => Promise<T> | T): Promise<{ session: ActiveSession; result: T }> {
  return withSessionLock(ACTIVE_SESSION_LOCK, async () => {
    const session = getActiveSession();
    const result = await mutate(session);
    session.updatedAt = new Date().toISOString();
    writeSession(session);
    return { session, result };
  });
}

async function withSessionLock<T>(sessionId: string, task: () => Promise<T> | T): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => task());
  let chained: Promise<unknown>;
  chained = next.finally(() => {
    if (sessionQueues.get(sessionId) === chained) {
      sessionQueues.delete(sessionId);
    }
  });
  sessionQueues.set(sessionId, chained);
  return next;
}

function registerRunningRequest(sessionId: string, controller: AbortController): void {
  const controllers = runningRequests.get(sessionId) ?? new Set<AbortController>();
  controllers.add(controller);
  runningRequests.set(sessionId, controllers);
}

function unregisterRunningRequest(sessionId: string, controller: AbortController): void {
  const controllers = runningRequests.get(sessionId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) {
    runningRequests.delete(sessionId);
  }
}

function abortRunningRequests(sessionId: string): void {
  const controllers = runningRequests.get(sessionId);
  if (!controllers) return;
  for (const controller of controllers) {
    controller.abort();
  }
  runningRequests.delete(sessionId);
}
