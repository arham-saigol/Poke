import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
// Note: node:sqlite is an unstable RC API. We attempt to use it but fall back to better-sqlite3 if unavailable.
import { automationsFileSchema, defaultModels, pokeConfigSchema } from "@poke/shared";
// We use createRequire to load CommonJS native modules (node:sqlite RC export and
// better-sqlite3) from this ESM module; bare `require` is not defined in ESM.
const requireFromHere = createRequire(import.meta.url);
export function getPokeHome() {
    return process.env.POKE_HOME ? path.resolve(process.env.POKE_HOME) : path.join(os.homedir(), ".poke");
}
export function getPokePaths(home = getPokeHome()) {
    return {
        home,
        config: path.join(home, "config.json"),
        secrets: path.join(home, "secrets.enc.json"),
        secretKey: path.join(home, ".secret-key"),
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
export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
export function pathInside(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
export function safeResolve(root, relativePath) {
    const resolved = path.resolve(root, relativePath);
    if (!pathInside(root, resolved)) {
        throw new Error(`Path escapes allowed root: ${relativePath}`);
    }
    return resolved;
}
export function defaultAutomation(timezone) {
    return {
        name: "Weekly memory cleanup",
        description: "Reviews Poke memory weekly, consolidates overlapping notes, removes stale entries, and keeps an audit report.",
        enabled: true,
        kind: "recurring",
        schedule: { type: "cron", value: "0 2 * * 0", timezone },
        action: { type: "command", command: "poke memory cleanup", timeoutSeconds: 1800 },
        createdBy: "system",
        updatedAt: new Date().toISOString()
    };
}
export function defaultConfig(paths = getPokePaths(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
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
export function bootstrapPokeHome(options = {}) {
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
        fs.writeFileSync(paths.memoryIndex, "# Poke Memory Index\n\nThis file lists memory categories and files available to Poke.\n", "utf8");
    }
    if (!fs.existsSync(paths.secrets) || options.force) {
        createInitialSecrets(paths);
    }
    try {
        migrateDatabase(paths);
    }
    catch (error) {
        // Fail-fast: a broken schema means subsequent reads/writes will silently
        // misbehave, so propagate the failure to the caller after recording it.
        appendLog("error", "storage.migration_failed", {
            error: error instanceof Error ? error.stack ?? error.message : String(error)
        }, paths);
        throw error;
    }
    return paths;
}
export function readConfig(paths = getPokePaths()) {
    const raw = JSON.parse(fs.readFileSync(paths.config, "utf8"));
    return pokeConfigSchema.parse(raw);
}
export function writeConfig(config, paths = getPokePaths()) {
    writeJson(paths.config, pokeConfigSchema.parse(config));
}
export function readAutomations(paths = getPokePaths()) {
    const raw = JSON.parse(fs.readFileSync(paths.automations, "utf8"));
    return automationsFileSchema.parse(raw);
}
export function writeJson(file, value) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
export function openDatabase(paths = getPokePaths()) {
    ensureDir(path.dirname(paths.database));
    // Try node:sqlite first (unstable RC API)
    try {
        const { DatabaseSync } = requireFromHere("node:sqlite");
        return new DatabaseSync(paths.database);
    }
    catch (sqliteError) {
        // Fall back to better-sqlite3
        try {
            const Database = requireFromHere("better-sqlite3");
            return new Database(paths.database);
        }
        catch (betterSqliteError) {
            throw new Error(`Failed to load database driver. Tried node:sqlite (${String(sqliteError)}) and better-sqlite3 (${String(betterSqliteError)}). Install better-sqlite3 or use Node.js with sqlite support.`);
        }
    }
}
export function migrateDatabase(paths = getPokePaths()) {
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
      create index if not exists idx_daemon_events_level on daemon_events(level);
      create index if not exists idx_daemon_events_created_at on daemon_events(created_at);
      create index if not exists idx_automation_runs_automation_name on automation_runs(automation_name);
      create index if not exists idx_automation_runs_status on automation_runs(status);
      create index if not exists idx_automation_runs_started_at on automation_runs(started_at);
      create index if not exists idx_audit_events_actor on audit_events(actor);
      create index if not exists idx_audit_events_action on audit_events(action);
      create index if not exists idx_audit_events_target on audit_events(target);
      create index if not exists idx_audit_events_created_at on audit_events(created_at);
    `);
        db.prepare("insert or ignore into schema_migrations (version, applied_at) values (?, ?)").run(1, new Date().toISOString());
    }
    finally {
        db.close();
    }
}
export function audit(action, target, metadata, actor = "system", paths) {
    const activePaths = paths ?? getPokePaths();
    let db;
    try {
        db = openDatabase(activePaths);
        db.prepare("insert into audit_events (actor, action, target, metadata, created_at) values (?, ?, ?, ?, ?)").run(actor, action, target ?? null, metadata ? JSON.stringify(metadata) : null, new Date().toISOString());
    }
    catch (error) {
        appendLog("warn", "audit.write_failed", { action, target, error: String(error) }, activePaths);
    }
    finally {
        db?.close();
    }
}
export function appendLog(level, message, metadata, paths) {
    const activePaths = paths ?? getPokePaths();
    ensureDir(activePaths.logs);
    const entry = { time: new Date().toISOString(), level, message, metadata: metadata ? redactSecrets(metadata) : undefined };
    fs.appendFileSync(path.join(activePaths.logs, "gateway.log"), `${JSON.stringify(entry)}\n`, "utf8");
}
function secretKey(paths = getPokePaths()) {
    // If POKE_SECRET_KEY is provided, use it
    if (process.env.POKE_SECRET_KEY) {
        return crypto.createHash("sha256").update(process.env.POKE_SECRET_KEY).digest();
    }
    // Try to read existing key file
    if (fs.existsSync(paths.secretKey)) {
        try {
            const keyData = fs.readFileSync(paths.secretKey, "utf8");
            return Buffer.from(keyData, "hex");
        }
        catch (error) {
            appendLog("warn", "storage.secret_key_read_failed", { error: String(error) }, paths);
        }
    }
    // Generate a new cryptographically secure key
    const newKey = crypto.randomBytes(32);
    try {
        // Write the key to file with restrictive permissions
        ensureDir(paths.home);
        fs.writeFileSync(paths.secretKey, newKey.toString("hex"), { mode: 0o600 });
        appendLog("warn", "storage.secret_key_generated", {
            message: "Generated new encryption key. For production use, set POKE_SECRET_KEY environment variable."
        }, paths);
    }
    catch (error) {
        appendLog("error", "storage.secret_key_write_failed", { error: String(error) }, paths);
        throw new Error(`Failed to persist generated secret key at ${paths.secretKey}. Set POKE_SECRET_KEY or fix filesystem permissions.`);
    }
    return newKey;
}
function encrypt(value, paths) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(paths), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
}
function decrypt(value, paths) {
    const data = Buffer.from(value, "base64");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(paths), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
export function createInitialSecrets(paths = getPokePaths()) {
    const file = {
        version: 1,
        keyHint: process.env.POKE_SECRET_KEY ? "env:POKE_SECRET_KEY" : "file:.secret-key",
        values: {
            "web-session-secret": encrypt(crypto.randomBytes(32).toString("hex"), paths)
        }
    };
    writeJson(paths.secrets, file);
}
export function setSecret(name, value, paths = getPokePaths()) {
    updateSecrets({ [name]: value }, paths);
}
export function getSecret(name, paths = getPokePaths()) {
    const file = readSecretsFile(paths);
    const value = file.values[name];
    return value ? decrypt(value, paths) : null;
}
export function deleteSecret(name, paths = getPokePaths()) {
    updateSecrets({ [name]: null }, paths);
}
export function updateSecrets(updates, paths = getPokePaths()) {
    const file = readSecretsFile(paths);
    for (const [name, value] of Object.entries(updates)) {
        if (value === undefined)
            continue;
        if (value === null || value === "") {
            delete file.values[name];
            continue;
        }
        file.values[name] = encrypt(value, paths);
    }
    writeJson(paths.secrets, file);
}
function readSecretsFile(paths = getPokePaths()) {
    return JSON.parse(fs.readFileSync(paths.secrets, "utf8"));
}
export function createBackup(label = "manual", paths = getPokePaths()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const hrtime = process.hrtime.bigint();
    const sanitizedLabel = sanitizeBackupLabel(label);
    const target = path.join(paths.backups, `${stamp}-${hrtime}-${sanitizedLabel}`);
    if (!pathInside(paths.backups, target)) {
        throw new Error(`Backup target escapes backup directory: ${target}`);
    }
    ensureDir(target);
    const entries = [
        paths.config,
        paths.secrets,
        paths.secretKey,
        paths.database,
        paths.automations,
        paths.memory,
        paths.skills,
        paths.workspace
    ];
    for (const entry of entries) {
        if (!fs.existsSync(entry))
            continue;
        const destination = path.join(target, path.basename(entry));
        fs.cpSync(entry, destination, { recursive: true, force: true, errorOnExist: true });
    }
    audit("backup.create", target, { label: sanitizedLabel }, "system", paths);
    return target;
}
export function restoreBackup(backupPath, paths = getPokePaths()) {
    const source = path.resolve(backupPath);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
        throw new Error(`Backup directory does not exist: ${backupPath}`);
    }
    ensureDir(paths.backups);
    const backupsDirReal = fs.realpathSync(paths.backups);
    const sourceReal = fs.realpathSync(source);
    if (sourceReal !== backupsDirReal && !sourceReal.startsWith(`${backupsDirReal}${path.sep}`)) {
        throw new Error(`Backup path must be inside ${paths.backups}: ${backupPath}`);
    }
    const safetyBackup = createBackup("pre-restore", paths);
    const entries = [
        "config.json",
        "secrets.enc.json",
        ".secret-key",
        "poke.db",
        "automations.json",
        "memory",
        "skills",
        "workspace"
    ];
    for (const entry of entries) {
        const from = path.join(source, entry);
        if (!fs.existsSync(from))
            continue;
        const to = path.join(paths.home, entry);
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true, force: true });
    }
    audit("backup.restore", source, { safetyBackup }, "system", paths);
    return { restoredFrom: source, safetyBackup };
}
export function listBackups(paths = getPokePaths()) {
    ensureDir(paths.backups);
    return fs.readdirSync(paths.backups, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
        const full = path.join(paths.backups, entry.name);
        return { name: entry.name, path: full, createdAt: fs.statSync(full).birthtime.toISOString() };
    })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function listAuditEvents(limit = 50) {
    let db;
    try {
        db = openDatabase();
        return db.prepare("select id, actor, action, target, metadata, created_at as createdAt from audit_events order by id desc limit ?").all(limit)
            .map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
    }
    catch (error) {
        appendLog("warn", "audit.read_failed", { error: String(error) });
        return [];
    }
    finally {
        db?.close();
    }
}
export function readRecentLogs(lines = 100, paths = getPokePaths()) {
    const logFile = path.join(paths.logs, "gateway.log");
    if (!fs.existsSync(logFile))
        return [];
    return fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-lines);
}
function redactSecrets(value) {
    if (Array.isArray(value))
        return value.map(redactSecrets);
    if (!value || typeof value !== "object")
        return value;
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (/secret|token|key|credential|password/i.test(key)) {
            result[key] = "[redacted]";
        }
        else {
            result[key] = redactSecrets(entry);
        }
    }
    return result;
}
function sanitizeBackupLabel(label) {
    const sanitized = label
        .replace(/[\\/]+/g, "-")
        .replace(/\.\.+/g, "-")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-._]+|[-._]+$/g, "");
    return sanitized || "manual";
}
//# sourceMappingURL=index.js.map