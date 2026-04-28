import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAgentRuntime } from "@poke/agent-runtime";
import { loadAutomations } from "@poke/automations";
import { getActiveSession, receiveMessage } from "@poke/channels";
import { createWhatsAppRuntime, type WhatsAppRuntime } from "@poke/channels/whatsapp";
import { seedBundledSkills } from "@poke/skills";
import { appendLog, bootstrapPokeHome, getPokePaths, listAuditEvents, migrateDatabase, readConfig, readRecentLogs } from "@poke/storage";

const paths = bootstrapPokeHome();
seedBundledSkills(paths);
try {
  migrateDatabase(paths);
} catch (error) {
  appendLog("warn", "storage.sqlite_unavailable", { error: String(error) });
}
const startedAt = new Date();
const port = Number(process.env.POKE_GATEWAY_PORT ?? 43210);
const rateLimits = new Map<string, { count: number; resetAt: number }>();

fs.writeFileSync(paths.pid, String(process.pid), "utf8");
appendLog("info", "gateway.start", { pid: process.pid, port });
let whatsappRuntime: WhatsAppRuntime | null = null;
if (process.env.POKE_ENABLE_WHATSAPP === "1") {
  createWhatsAppRuntime()
    .then(async (runtime) => {
      whatsappRuntime = runtime;
      await runtime.connect();
      appendLog("info", "whatsapp.connected");
    })
    .catch((error) => appendLog("error", "whatsapp.connect_failed", { error: String(error) }));
}

const server = http.createServer(async (request, response) => {
  if (!allowRequest(request)) {
    sendJson(response, { error: "rate limit exceeded" }, 429);
    return;
  }
  if (request.url === "/health") {
    const config = readConfig(paths);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: startedAt.toISOString(),
        publicBaseUrl: config.publicBaseUrl
      })
    );
    return;
  }

  if (request.url === "/runtime") {
    const runtime = createAgentRuntime();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ parentTools: runtime.parentTools, childTools: runtime.childTools }));
    return;
  }

  if (request.url === "/status") {
    sendJson(response, {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: startedAt.toISOString(),
      audit: listAuditEvents(20),
      logs: readRecentLogs(20, paths)
    });
    return;
  }

  if (request.url === "/automations") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(loadAutomations()));
    return;
  }

  if (request.url === "/session" && request.method === "GET") {
    sendJson(response, getActiveSession());
    return;
  }

  if (request.url === "/message" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, await receiveMessage({ channel: "web", content: String(body.content ?? ""), mediaPath: body.mediaPath }));
    } catch (error) {
      sendJson(response, { error: String(error) }, 400);
    }
    return;
  }

  if (request.url === "/whatsapp/inbound" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, await receiveMessage({ channel: "whatsapp", content: String(body.content ?? ""), mediaPath: body.mediaPath, from: body.from }));
    } catch (error) {
      sendJson(response, { error: String(error) }, 403);
    }
    return;
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Poke gateway is running.\n");
});

function sendJson(response: http.ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readJsonBody(request: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
      if (Buffer.byteLength(raw) > 1024 * 1024) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function allowRequest(request: http.IncomingMessage): boolean {
  const key = request.socket.remoteAddress ?? "local";
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.resetAt < now) {
    rateLimits.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= 120;
}

server.listen(port, "127.0.0.1", () => {
  appendLog("info", "gateway.listen", { address: `127.0.0.1:${port}` });
});

function shutdown(signal: string): void {
  appendLog("info", "gateway.stop", { signal, pid: process.pid });
  server.close(() => {
    void whatsappRuntime?.disconnect();
    try {
      if (fs.existsSync(paths.pid) && fs.readFileSync(paths.pid, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(paths.pid);
      }
    } catch (error) {
      appendLog("warn", "gateway.pid_cleanup_failed", { error: String(error) });
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  appendLog("error", "gateway.uncaught_exception", { error: error.stack ?? error.message });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  appendLog("error", "gateway.unhandled_rejection", { reason: String(reason) });
});

export function gatewayLogPath(): string {
  return path.join(getPokePaths().logs, "gateway.log");
}
