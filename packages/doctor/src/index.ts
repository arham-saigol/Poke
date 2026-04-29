#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { bootstrapPokeHome, getPokePaths, getSecret, openDatabase } from "@poke/storage";

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
};

const paths = bootstrapPokeHome();
const checks: Check[] = [
  checkNode(),
  checkCommand("pnpm", true),
  checkWritable(paths.home, true, "Poke home writable"),
  checkSqlite(),
  checkCommand("cloudflared", false),
  checkCommand("yt-dlp", false),
  checkCommand("ffmpeg", false),
  checkSecret("openai-api-key", false),
  checkSecret("exa-api-key", false),
  checkSecret("exa-backup-api-key", false),
  checkSecret("vercel-ai-gateway-api-key", false),
  checkSecret("deepgram-api-key", false)
];

let failed = false;
for (const check of checks) {
  const marker = check.ok ? "ok" : check.required ? "fail" : "warn";
  console.log(`[${marker}] ${check.name}: ${check.detail}`);
  if (!check.ok && check.required) failed = true;
}

process.exitCode = failed ? 1 : 0;

function checkNode(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "Node.js",
    ok: major >= 22,
    detail: `found ${process.version}; expected >= 22`,
    required: true
  };
}

function checkCommand(command: string, required: boolean): Check {
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(checker, args, { shell: process.platform !== "win32", stdio: "ignore" });
  return {
    name: command,
    ok: result.status === 0,
    detail: result.status === 0 ? "found" : "not found",
    required
  };
}

function checkWritable(dir: string, required: boolean, name: string): Check {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.poke-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return { name, ok: true, detail: dir, required };
  } catch (error) {
    return { name, ok: false, detail: String(error), required };
  }
}

function checkSqlite(): Check {
  try {
    const db = openDatabase(getPokePaths());
    db.prepare("select 1 as ok").get();
    db.close();
    return { name: "SQLite", ok: true, detail: "database opened and queried", required: true };
  } catch (error) {
    return { name: "SQLite", ok: false, detail: String(error), required: true };
  }
}

function checkSecret(name: string, required: boolean): Check {
  try {
    const value = getSecret(name);
    return { name, ok: Boolean(value), detail: value ? "configured" : "not configured", required };
  } catch (error) {
    return { name, ok: false, detail: String(error), required };
  }
}
