import fs from "node:fs";
import path from "node:path";
import { appendLog, audit, createBackup, ensureDir, getPokePaths, safeResolve, type PokePaths } from "@poke/storage";

export type MemoryFile = {
  path: string;
  title: string;
  content: string;
  category: string;
  updatedAt: string;
};

export type MemoryCleanupReport = {
  backupPath: string;
  reportPath: string;
  consolidator: string;
  advisory: string;
  judge: string;
  mutationsApplied: number;
};

export function getIndex(paths = getPokePaths()): { path: "index.md"; content: string } {
  ensureMemory(paths);
  return { path: "index.md", content: fs.readFileSync(paths.memoryIndex, "utf8") };
}

export function readMemory(relativePath: string, paths = getPokePaths()): MemoryFile {
  ensureMemory(paths);
  const file = resolveMemoryFile(relativePath, paths);
  if (!fs.existsSync(file)) {
    throw new Error(`Memory file does not exist: ${relativePath}`);
  }
  const raw = fs.readFileSync(file, "utf8");
  const parsed = parseMemoryMarkdown(raw);
  return {
    path: toMemoryRelative(file, paths),
    title: parsed.frontmatter.title ?? titleFromPath(file),
    content: parsed.body,
    category: parsed.frontmatter.category ?? categoryFromRelative(toMemoryRelative(file, paths)),
    updatedAt: parsed.frontmatter.updatedAt ?? fs.statSync(file).mtime.toISOString()
  };
}

export function writeMemory(input: { path: string; title?: string; content: string }, paths = getPokePaths()): {
  path: string;
  created: boolean;
  updatedIndex: boolean;
} {
  ensureMemory(paths);
  const file = resolveMemoryFile(input.path, paths);
  const created = !fs.existsSync(file);
  if (created && !input.title) {
    throw new Error("Creating a memory requires a title.");
  }
  const existing = created ? null : readMemory(input.path, paths);
  const title = input.title ?? existing?.title ?? titleFromPath(file);
  const category = categoryFromRelative(toMemoryRelative(file, paths));
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, formatMemoryMarkdown({ title, category, content: input.content }), "utf8");
  rebuildIndex(paths);
  audit(created ? "memory.create" : "memory.update", toMemoryRelative(file, paths), { title });
  return { path: toMemoryRelative(file, paths), created, updatedIndex: true };
}

export function deleteMemory(relativePath: string, paths = getPokePaths()): { path: string; deleted: boolean; updatedIndex: boolean } {
  ensureMemory(paths);
  const file = resolveMemoryFile(relativePath, paths);
  if (!fs.existsSync(file)) {
    return { path: toMemoryRelative(file, paths), deleted: false, updatedIndex: false };
  }
  fs.unlinkSync(file);
  pruneEmptyDirs(path.dirname(file), paths.memory);
  rebuildIndex(paths);
  audit("memory.delete", toMemoryRelative(file, paths));
  return { path: toMemoryRelative(file, paths), deleted: true, updatedIndex: true };
}

export function listMemoryFiles(paths = getPokePaths()): MemoryFile[] {
  ensureMemory(paths);
  return walkMarkdown(paths.memory)
    .filter((file) => path.resolve(file) !== path.resolve(paths.memoryIndex))
    .map((file) => readMemory(toMemoryRelative(file, paths), paths));
}

export function runMemoryCleanup(paths = getPokePaths()): MemoryCleanupReport {
  ensureMemory(paths);
  const backupPath = createBackup("memory-cleanup", paths);
  const memories = listMemoryFiles(paths);
  const duplicateTitles = findDuplicateTitles(memories);
  const stale = memories.filter((memory) => Date.now() - Date.parse(memory.updatedAt) > 1000 * 60 * 60 * 24 * 365);
  const consolidator = [
    "Consolidator report",
    `Memory files reviewed: ${memories.length}`,
    duplicateTitles.length ? `Potential duplicate titles: ${duplicateTitles.join(", ")}` : "No duplicate titles found.",
    stale.length ? `Potential stale memories: ${stale.map((memory) => memory.path).join(", ")}` : "No stale memories found.",
    "No automatic destructive changes were proposed by the local fallback runner."
  ].join("\n");
  const advisory = [
    "Advisory report",
    "No objections to taking no destructive action.",
    "Model-backed consolidation should review semantic overlap before merging or deleting memories."
  ].join("\n");
  const judge = [
    "Judge decision",
    "Applied mutations: 0",
    "Reason: Block 2 local runner is conservative until model execution is wired into the agent runtime."
  ].join("\n");
  const reportDir = path.join(paths.backups, "memory-cleanup-reports");
  ensureDir(reportDir);
  const reportPath = path.join(reportDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(
    reportPath,
    `# Memory Cleanup Report\n\n## Backup\n\n${backupPath}\n\n## Consolidator\n\n${consolidator}\n\n## Advisory\n\n${advisory}\n\n## Judge\n\n${judge}\n`,
    "utf8"
  );
  appendLog("info", "memory.cleanup.completed", { backupPath, reportPath, reviewed: memories.length, mutationsApplied: 0 });
  audit("memory.cleanup.completed", reportPath, { backupPath, reviewed: memories.length, mutationsApplied: 0 });
  return { backupPath, reportPath, consolidator, advisory, judge, mutationsApplied: 0 };
}

function ensureMemory(paths: PokePaths): void {
  ensureDir(paths.memory);
  if (!fs.existsSync(paths.memoryIndex)) {
    fs.writeFileSync(paths.memoryIndex, "# Poke Memory Index\n\nNo memories yet.\n", "utf8");
  }
}

function resolveMemoryFile(relativePath: string, paths: PokePaths): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized.endsWith(".md")) {
    throw new Error("Memory paths must end in .md");
  }
  if (normalized === "index.md") {
    throw new Error("Use get_index for index.md; memory file tools operate on category files.");
  }
  return safeResolve(paths.memory, normalized);
}

function toMemoryRelative(file: string, paths: PokePaths): string {
  return path.relative(paths.memory, file).replaceAll("\\", "/");
}

function categoryFromRelative(relativePath: string): string {
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts[0]! : "general";
}

function titleFromPath(file: string): string {
  return path.basename(file, ".md").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatMemoryMarkdown(input: { title: string; category: string; content: string }): string {
  return [
    "---",
    `title: ${yamlString(input.title)}`,
    `updatedAt: ${new Date().toISOString()}`,
    `category: ${yamlString(input.category)}`,
    "---",
    "",
    input.content.trim(),
    ""
  ].join("\n");
}

function parseMemoryMarkdown(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, body: raw.trim() };
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: raw.trim() };
  const frontmatterBlock = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).trim();
  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterBlock.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^"|"$/g, "");
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function rebuildIndex(paths: PokePaths): void {
  const memories = listMemoryFiles(paths);
  const byCategory = new Map<string, MemoryFile[]>();
  for (const memory of memories) {
    const items = byCategory.get(memory.category) ?? [];
    items.push(memory);
    byCategory.set(memory.category, items);
  }
  const lines = ["# Poke Memory Index", ""];
  for (const [category, items] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${category}`, "");
    for (const item of items.sort((a, b) => a.title.localeCompare(b.title))) {
      lines.push(`- [${item.title}](${item.path})`);
    }
    lines.push("");
  }
  if (lines.length === 2) lines.push("No memories yet.", "");
  fs.writeFileSync(paths.memoryIndex, lines.join("\n"), "utf8");
}

function walkMarkdown(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkMarkdown(full));
    if (entry.isFile() && entry.name.endsWith(".md")) result.push(full);
  }
  return result;
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
  if (path.resolve(dir) === path.resolve(stopAt)) return;
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    pruneEmptyDirs(path.dirname(dir), stopAt);
  }
}

function findDuplicateTitles(memories: MemoryFile[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const memory of memories) {
    const key = memory.title.toLowerCase();
    if (seen.has(key)) duplicates.add(memory.title);
    seen.add(key);
  }
  return [...duplicates];
}
