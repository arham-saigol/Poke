import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  automationsFileSchema,
  defaultModels,
  pokeConfigSchema,
  type Automation,
  type PokeConfig
} from "@poke/shared";

export type PokePaths = {
  home: string;
  config: string;
  secrets: string;
  database: string;
  pid: string;
  session: string;
  automations: string;
  memory: string;
  memoryIndex: string;
  workspace: string;
  skills: string;
  enabledSkills: string;
  disabledSkills: string;
  logs: string;
  backups: string;
  whatsapp: string;
};

export function getPokeHome(): string {
  return process.env.POKE_HOME ? path.resolve(process.env.POKE_HOME) : path.join(os.homedir(), ".poke");
}

export function getPokePaths(home = getPokeHome()): PokePaths {
  return {
    home,
    config: path.join(home, "config.json"),
    secrets: path.join(home, "secrets.enc.json"),
    database: path.join(home, "poke.db"),
    pid: path.join(home, "poke.pid"),
    session: path.join(home, "session.json"),
    automations: path.join(home, "automations.json"),
    memory: path.join(home, "memory"),
    memoryIndex: path.join(home, "memory", "index.md"),
    workspace: path.join(home, "workspace"),
    skills: path.join(home, "skills"),
    enabledSkills: path.join(home, "skills", "enabled"),
    disabledSkills: path.join(home, "skills", "disabled"),
    logs: path.join(home, "logs"),
    backups: path.join(home, "backups"),
    whatsapp: path.join(home, "whatsapp")
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function safeResolve(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  if (!pathInside(root, resolved)) {
    throw new Error(`Path escapes allowed root: ${relativePath}`);
  }
  return resolved;
}

export function defaultAutomation(timezone: string): Automation {
  return {
    name: "Weekly memory cleanup",
    description:
      "Reviews Poke memory weekly, consolidates overlapping notes, removes stale entries, and keeps an audit report.",
    enabled: true,
    kind: "recurring",
    schedule: { type: "cron", value: "0 2 * * 0", timezone },
    action: { type: "command", command: "poke memory cleanup", timeoutSeconds: 1800 },
    createdBy: "system",
    updatedAt: new Date().toISOString()
  };
}

export function defaultConfig(paths = getPokePaths(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): PokeConfig {
  return {
    version: 1,
    instanceId: crypto.randomUUID(),
    publicBaseUrl: null,
    timezone,
    paths: {
      home: paths.home,
      workspace: paths.workspace,
      memory: paths.memory,
      skills: paths.skills,
      logs: paths.logs
    },
    auth: {
      webSessionSecretRef: "web-session-secret",
      cloudflareAccessEnabled: false,
      allowedEmail: null
    },
    models: defaultModels,
    channels: {
      web: { enabled: true },
      whatsapp: { enabled: false, adapter: "baileys", allowedNumber: null }
    }
  };
}

export function bootstrapPokeHome(options: { home?: string; force?: boolean } = {}): PokePaths {
  const paths = getPokePaths(options.home);
  for (const dir of [
    paths.home,
    paths.memory,
    paths.workspace,
    paths.enabledSkills,
    paths.disabledSkills,
    paths.logs,
    paths.backups,
    paths.whatsapp
  ]) {
    ensureDir(dir);
  }

  if (!fs.existsSync(paths.config) || options.force) {
    writeJson(paths.config, defaultConfig(paths));
  }
  if (!fs.existsSync(paths.automations) || options.force) {
    const config = readConfig(paths);
    writeJson(paths.automations, [defaultAutomation(config.timezone)]);
  }
  if (!fs.existsSync(paths.memoryIndex) || options.force) {
    fs.writeFileSync(
      paths.memoryIndex,
      "# Poke Memory Index\n\nThis file lists memory categories and files available to Poke.\n",
      "utf8"
    );
  }
  if (!fs.existsSync(paths.secrets) || options.force) {
    createInitialSecrets(paths);
  }
  try {
    migrateDatabase(paths);
  } catch (error) {
    appendLog("warn", "storage.migration_failed", { error: String(error) });
  }
  return paths;
}

export function readConfig(paths = getPokePaths()): PokeConfig {
  const raw = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  return pokeConfigSchema.parse(raw);
}

export function writeConfig(config: PokeConfig, paths = getPokePaths()): void {
  writeJson(paths.config, pokeConfigSchema.parse(config));
}

export function readAutomations(paths = getPokePaths()): Automation[] {
  const raw = JSON.parse(fs.readFileSync(paths.automations, "utf8"));
  return automationsFileSchema.parse(raw);
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function openDatabase(paths = getPokePaths()): any {
  ensureDir(path.dirname(paths.database));
  return new DatabaseSync(paths.database);
}

export function migrateDatabase(paths = getPokePaths()): void {
  const db = openDatabase(paths);
  try {
    db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        applied_at text not null
      );
      create table if not exists daemon_events (
        id integer primary key autoincrement,
        level text not null,
        message text not null,
        metadata text,
        created_at text not null
      );
      create table if not exists automation_runs (
        id integer primary key autoincrement,
        automation_name text not null,
        status text not null,
        started_at text not null,
        finished_at text,
        output text,
        error text
      );
      create table if not exists audit_events (
        id integer primary key autoincrement,
        actor text not null,
        action text not null,
        target text,
        metadata text,
        created_at text not null
      );
    `);
    db.prepare("insert or ignore into schema_migrations (version, applied_at) values (?, ?)").run(1, new Date().toISOString());
  } finally {
    db.close();
  }
}

export function audit(action: string, target?: string, metadata?: Record<string, unknown>, actor = "system"): void {
  let db: any;
  try {
    db = openDatabase();
    db.prepare(
      "insert into audit_events (actor, action, target, metadata, created_at) values (?, ?, ?, ?, ?)"
    ).run(actor, action, target ?? null, metadata ? JSON.stringify(metadata) : null, new Date().toISOString());
  } catch (error) {
    appendLog("warn", "audit.write_failed", { action, target, error: String(error) });
  } finally {
    db?.close();
  }
}

export function appendLog(level: "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>): void {
  const paths = getPokePaths();
  ensureDir(paths.logs);
  const entry = { time: new Date().toISOString(), level, message, metadata: metadata ? redactSecrets(metadata) : undefined };
  fs.appendFileSync(path.join(paths.logs, "gateway.log"), `${JSON.stringify(entry)}\n`, "utf8");
}

type SecretsFile = {
  version: 1;
  keyHint: string;
  values: Record<string, string>;
};

function secretKey(): Buffer {
  const source = process.env.POKE_SECRET_KEY ?? `${os.userInfo().username}:${os.hostname()}:poke-local-secret`;
  return crypto.createHash("sha256").update(source).digest();
}

function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(value: string): string {
  const data = Buffer.from(value, "base64");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function createInitialSecrets(paths = getPokePaths()): void {
  const file: SecretsFile = {
    version: 1,
    keyHint: process.env.POKE_SECRET_KEY ? "env:POKE_SECRET_KEY" : "local-machine-derived",
    values: {
      "web-session-secret": encrypt(crypto.randomBytes(32).toString("hex"))
    }
  };
  writeJson(paths.secrets, file);
}

export function setSecret(name: string, value: string, paths = getPokePaths()): void {
  const file = readSecretsFile(paths);
  file.values[name] = encrypt(value);
  writeJson(paths.secrets, file);
}

export function getSecret(name: string, paths = getPokePaths()): string | null {
  const file = readSecretsFile(paths);
  const value = file.values[name];
  return value ? decrypt(value) : null;
}

function readSecretsFile(paths = getPokePaths()): SecretsFile {
  return JSON.parse(fs.readFileSync(paths.secrets, "utf8")) as SecretsFile;
}

export function createBackup(label = "manual", paths = getPokePaths()): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(paths.backups, `${stamp}-${label}`);
  ensureDir(target);
  const entries = [
    paths.config,
    paths.secrets,
    paths.database,
    paths.automations,
    paths.memory,
    paths.skills,
    paths.workspace
  ];
  for (const entry of entries) {
    if (!fs.existsSync(entry)) continue;
    const destination = path.join(target, path.basename(entry));
    fs.cpSync(entry, destination, { recursive: true, force: false, errorOnExist: false });
  }
  audit("backup.create", target, { label });
  return target;
}

export function restoreBackup(backupPath: string, paths = getPokePaths()): { restoredFrom: string; safetyBackup: string } {
  const source = path.resolve(backupPath);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Backup directory does not exist: ${backupPath}`);
  }
  const safetyBackup = createBackup("pre-restore", paths);
  const entries = [
    "config.json",
    "secrets.enc.json",
    "poke.db",
    "automations.json",
    "memory",
    "skills",
    "workspace"
  ];
  for (const entry of entries) {
    const from = path.join(source, entry);
    if (!fs.existsSync(from)) continue;
    const to = path.join(paths.home, entry);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, force: true });
  }
  audit("backup.restore", source, { safetyBackup });
  return { restoredFrom: source, safetyBackup };
}

export function listBackups(paths = getPokePaths()): Array<{ name: string; path: string; createdAt: string }> {
  ensureDir(paths.backups);
  return fs.readdirSync(paths.backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(paths.backups, entry.name);
      return { name: entry.name, path: full, createdAt: fs.statSync(full).birthtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listAuditEvents(limit = 50): Array<Record<string, unknown>> {
  let db: any;
  try {
    db = openDatabase();
    return db.prepare("select id, actor, action, target, metadata, created_at as createdAt from audit_events order by id desc limit ?").all(limit)
      .map((row: any) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
  } catch (error) {
    appendLog("warn", "audit.read_failed", { error: String(error) });
    return [];
  } finally {
    db?.close();
  }
}

export function readRecentLogs(lines = 100, paths = getPokePaths()): string[] {
  const logFile = path.join(paths.logs, "gateway.log");
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-lines);
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/secret|token|key|credential|password/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactSecrets(entry);
    }
  }
  return result;
}
