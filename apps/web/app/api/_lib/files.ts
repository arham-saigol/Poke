import fs from "node:fs";
import path from "node:path";
import { getPokePaths, safeResolve } from "@poke/storage";

export type FileRoot = "workspace" | "memory" | "skills";

export function rootPath(root: string): string {
  const paths = getPokePaths();
  if (root === "workspace") return paths.workspace;
  if (root === "memory") return paths.memory;
  if (root === "skills") return paths.skills;
  throw new Error(`Unsupported file root: ${root}`);
}

export function resolveRootFile(root: string, relativePath = ""): string {
  return safeResolve(rootPath(root), relativePath);
}

export function fileTree(root: string, relativePath = ""): Array<{ name: string; path: string; type: "file" | "directory"; children?: any[] }> {
  const base = resolveRootFile(root, relativePath);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => {
      const full = path.join(base, entry.name);
      const rel = path.relative(rootPath(root), full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        return { name: entry.name, path: rel, type: "directory" as const, children: fileTree(root, rel) };
      }
      return { name: entry.name, path: rel, type: "file" as const };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}
