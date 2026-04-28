import fs from "node:fs";
import path from "node:path";
import { deleteMemory } from "@poke/memory";
import { readMemory, writeMemory } from "@poke/memory";
import { ensureDir } from "@poke/storage";
import { fileTree, resolveRootFile, rootPath } from "../_lib/files";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const root = url.searchParams.get("root") ?? "workspace";
  const relativePath = url.searchParams.get("path");
  if (!relativePath) return Response.json({ tree: fileTree(root) });
  const file = resolveRootFile(root, relativePath);
  if (url.searchParams.get("download")) {
    return new Response(fs.readFileSync(file), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${path.basename(file)}"`
      }
    });
  }
  if (root === "memory" && relativePath !== "index.md") {
    const memory = readMemory(relativePath);
    return Response.json({ path: relativePath, content: memory.content, title: memory.title });
  }
  return Response.json({ path: relativePath, content: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" });
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const root = url.searchParams.get("root") ?? "workspace";
  const body = await request.json() as any;
  const relativePath = String(body.path ?? "");
  const content = String(body.content ?? "");
  if (!relativePath) return Response.json({ error: "path is required" }, { status: 400 });
  if (root === "memory" && relativePath !== "index.md") {
    const existingTitle = body.title ? String(body.title) : fs.existsSync(resolveRootFile(root, relativePath)) ? readMemory(relativePath).title : path.basename(relativePath, ".md");
    return Response.json(writeMemory({ path: relativePath, title: existingTitle, content }));
  }
  const file = resolveRootFile(root, relativePath);
  if (!file.startsWith(rootPath(root))) return Response.json({ error: "invalid path" }, { status: 400 });
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, "utf8");
  return Response.json({ path: relativePath, bytes: Buffer.byteLength(content) });
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const root = url.searchParams.get("root") ?? "workspace";
  const relativePath = url.searchParams.get("path") ?? "";
  if (!relativePath) return Response.json({ error: "path is required" }, { status: 400 });
  
  // Normalize and validate path to prevent root deletes and traversal attacks
  const normalized = path.posix.normalize(relativePath);
  if (normalized === "." || normalized === "/" || normalized === "" || normalized === "./" ||
      normalized.startsWith("../") || normalized.includes("/../")) {
    return Response.json({ error: "invalid path: cannot delete root or traverse upward" }, { status: 400 });
  }
  
  if (root === "memory" && relativePath !== "index.md") {
    return Response.json(deleteMemory(relativePath));
  }
  const file = resolveRootFile(root, relativePath);
  fs.rmSync(file, { recursive: true, force: true });
  return Response.json({ path: relativePath, deleted: true });
}
