import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function tempHome(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `poke-${name}-`));
}

test("safeResolve rejects paths outside the root", async () => {
  const { safeResolve } = await import("../packages/storage/src/index.ts");
  const root = tempHome("safe");
  try {
    assert.throws(() => safeResolve(root, "../outside.txt"), /escapes/);
    assert.equal(safeResolve(root, "inside.txt"), path.join(root, "inside.txt"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("backup restore creates a safety backup and restores files", async () => {
  const originalPokeHome = process.env.POKE_HOME;
  const storage = await import("../packages/storage/src/index.ts");
  const home = tempHome("backup");
  try {
    process.env.POKE_HOME = home;
    const paths = storage.bootstrapPokeHome({ home });
    fs.writeFileSync(path.join(paths.workspace, "note.txt"), "before", "utf8");
    const backup = storage.createBackup("test", paths);
    fs.writeFileSync(path.join(paths.workspace, "note.txt"), "after", "utf8");
    const result = storage.restoreBackup(backup, paths);
    assert.ok(fs.existsSync(result.safetyBackup));
    assert.equal(fs.readFileSync(path.join(paths.workspace, "note.txt"), "utf8"), "before");
  } finally {
    if (originalPokeHome !== undefined) {
      process.env.POKE_HOME = originalPokeHome;
    } else {
      delete process.env.POKE_HOME;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
