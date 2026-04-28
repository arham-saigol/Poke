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
migrateDatabase(paths);
const startedAt = new Date();
const port = Number(process.env.POKE_GATEWAY_PORT ?? 43210);
const rateLimits = new Map<string, { count: number; resetAt: number }>();

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
  try {
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
      const serializableRuntime = {
        parentTools: runtime.parentTools.map((name) => ({ name, callable: true })),
        childTools: runtime.childTools.map((name) => ({ name, callable: true }))
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(serializableRuntime));
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
        const result = await receiveMessage({ channel: "web", content: String(body.content ?? ""), mediaPath: body.mediaPath });
        sendJson(response, result.session);
      } catch (error) {
        sendJson(response, { error: String(error) }, 400);
      }
      return;
    }

    if (request.url === "/whatsapp/inbound" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        const result = await receiveMessage({ channel: "whatsapp", content: String(body.content ?? ""), mediaPath: body.mediaPath, from: body.from });
        sendJson(response, result.session);
      } catch (error) {
        sendJson(response, { error: String(error) }, 403);
      }
      return;
    }

    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Poke gateway is running.\n");
  } catch (error) {
    appendLog("error", "gateway.http_handler_error", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
    if (!response.headersSent) {
      sendJson(response, { error: "internal server error" }, 500);
    }
  }
});

function sendJson(response: http.ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readJsonBody(request: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    const signal = (request as http.IncomingMessage & { signal?: AbortSignal }).signal;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      raw += String(chunk);
      if (Buffer.byteLength(raw) > 1024 * 1024) {
        fail(new Error("request body too large"));
        request.destroy();
      }
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    };

    const onError = (error: Error) => {
      fail(error);
    };

    const onClose = () => {
      if (!settled && !request.complete) {
        fail(new Error("request body closed before completion"));
      }
    };

    const onAbort = () => {
      fail(new Error("request aborted"));
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("close", onClose);

    if (signal) {
      if (signal.aborted) {
        fail(new Error("request aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
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
  fs.writeFileSync(paths.pid, String(process.pid), "utf8");
  appendLog("info", "gateway.start", { pid: process.pid, port });
  appendLog("info", "gateway.listen", { address: `127.0.0.1:${port}` });
});

server.on("error", (error) => {
  appendLog("error", "gateway.bind_failed", { error: String(error), port });
  process.exit(1);
});

function shutdown(signal: string): void {
  appendLog("info", "gateway.stop", { signal, pid: process.pid });
  server.close(async () => {
    try {
      if (whatsappRuntime) {
        await whatsappRuntime.disconnect();
      }
    } catch (error) {
      appendLog("error", "gateway.whatsapp_disconnect_failed", { error: String(error) });
    }
    try {
      if (fs.existsSync(paths.pid) && fs.readFileSync(paths.pid, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(paths.pid);
      }
    } catch (error) {
      appendLog("warn", "gateway.pid_cleanup_failed", { error: String(error) });
    }
    process.exit(0);
  });
  setTimeout(() => {
    appendLog("warn", "gateway.shutdown_timeout", { signal });
    process.exit(1);
  }, 10000);
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
