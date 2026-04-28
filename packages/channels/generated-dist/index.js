import crypto from "node:crypto";
import fs from "node:fs";
import { activeSessionSchema } from "@poke/shared";
import { appendLog, audit, bootstrapPokeHome, readConfig, writeJson } from "@poke/storage";
const ACTIVE_SESSION_LOCK = "active-session";
const sessionQueues = new Map();
const runningRequests = new Map();
export function getActiveSession() {
    const paths = bootstrapPokeHome();
    if (!fs.existsSync(paths.session)) {
        const now = new Date().toISOString();
        const session = {
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
export function newSession() {
    const now = new Date().toISOString();
    const session = {
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
export async function receiveMessage(input) {
    if (input.channel === "whatsapp") {
        assertAllowedWhatsAppSender(input.from);
    }
    if (input.content.trim().startsWith("/")) {
        const session = handleSlashCommand(input.content.trim(), input.channel);
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
        const loadRuntime = new Function("specifier", "return import(specifier)");
        const { parentTools } = await loadRuntime("@poke/agent-runtime");
        const child = await parentTools.ask_poke({ task: input.content, reasoning: result.reasoning, signal: controller.signal });
        unregisterRunningRequest(result.sessionId, controller);
        const responseMessage = message("assistant", input.channel, child.output, undefined, result.sessionId);
        const completion = await mutateActiveSession((current) => {
            if (current.id !== result.sessionId || controller.signal.aborted || current.status === "aborted") {
                return { responseMessage: null, shouldLog: false };
            }
            current.messages.push(responseMessage);
            current.status = "idle";
            return { responseMessage, shouldLog: true };
        });
        if (completion.result.shouldLog) {
            appendLog("info", "channel.message.processed", { channel: input.channel, sessionId: result.sessionId });
        }
        return { session: completion.session, responseMessage: completion.result.responseMessage };
    }
    catch (error) {
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
export function handleSlashCommand(command, channel) {
    const [name, arg] = command.split(/\s+/, 2);
    if (name === "/new")
        return newSession();
    const session = getActiveSession();
    if (name === "/abort") {
        session.status = "aborted";
        session.messages.push(message("system", "system", "Current Poke activity was aborted.", undefined, session.id));
        audit("session.abort", session.id, { channel });
        abortRunningRequests(session.id);
    }
    else if (name === "/reasoning") {
        const level = parseReasoning(arg);
        session.reasoning = level;
        session.messages.push(message("system", "system", `Parent reasoning set to ${level}.`, undefined, session.id));
        audit("session.reasoning", session.id, { level, channel });
    }
    else if (name === "/restart") {
        session.messages.push(message("system", "system", "Daemon restart requested. Use `poke restart` on the host to perform the restart in this scaffold.", undefined, session.id));
        audit("daemon.restart.requested", session.id, { channel });
    }
    else {
        session.messages.push(message("system", "system", `Unknown slash command: ${name}`, undefined, session.id));
    }
    session.updatedAt = new Date().toISOString();
    writeSession(session);
    return session;
}
export function writeSession(session) {
    const paths = bootstrapPokeHome();
    writeJson(paths.session, activeSessionSchema.parse(session));
}
export function getWhatsAppStatus() {
    const config = readConfig();
    return {
        enabled: config.channels.whatsapp.enabled,
        adapter: config.channels.whatsapp.adapter,
        allowedNumber: config.channels.whatsapp.allowedNumber,
        connected: false,
        instructions: "Baileys transport is installed. Start the gateway with POKE_ENABLE_WHATSAPP=1 after setting an allowed WhatsApp number; pairing material is kept in memory instead of gateway logs."
    };
}
function assertAllowedWhatsAppSender(from) {
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
function normalizePhone(value) {
    return value.replace(/\D/g, "");
}
function parseReasoning(value) {
    if (value === "low" || value === "medium" || value === "high")
        return value;
    return "low";
}
function message(role, channel, content, mediaPath, sessionId) {
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
async function mutateActiveSession(mutate) {
    return withSessionLock(ACTIVE_SESSION_LOCK, async () => {
        const session = getActiveSession();
        const result = await mutate(session);
        session.updatedAt = new Date().toISOString();
        writeSession(session);
        return { session, result };
    });
}
async function withSessionLock(sessionId, task) {
    const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => task());
    let chained;
    chained = next.finally(() => {
        if (sessionQueues.get(sessionId) === chained) {
            sessionQueues.delete(sessionId);
        }
    });
    sessionQueues.set(sessionId, chained);
    return next;
}
function registerRunningRequest(sessionId, controller) {
    const controllers = runningRequests.get(sessionId) ?? new Set();
    controllers.add(controller);
    runningRequests.set(sessionId, controllers);
}
function unregisterRunningRequest(sessionId, controller) {
    const controllers = runningRequests.get(sessionId);
    if (!controllers)
        return;
    controllers.delete(controller);
    if (controllers.size === 0) {
        runningRequests.delete(sessionId);
    }
}
function abortRunningRequests(sessionId) {
    const controllers = runningRequests.get(sessionId);
    if (!controllers)
        return;
    for (const controller of controllers) {
        controller.abort();
    }
    runningRequests.delete(sessionId);
}
//# sourceMappingURL=index.js.map