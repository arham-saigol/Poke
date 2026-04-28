import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "poke-memory-"));
}

test("memory writes rebuild the index and delete removes entries", async (t) => {
  const storage = await import("../packages/storage/src/index.ts");
  const memory = await import("../packages/memory/src/index.ts");
  const home = tempHome();
  const originalPokeHome = process.env.POKE_HOME;
  
  t.after(() => {
    process.env.POKE_HOME = originalPokeHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  
  process.env.POKE_HOME = home;
  const paths = storage.bootstrapPokeHome({ home });
  memory.writeMemory({ path: "preferences/tone.md", title: "Tone", content: "Concise." }, paths);
  assert.match(memory.getIndex(paths).content, /Tone/);
  assert.equal(memory.readMemory("preferences/tone.md", paths).content, "Concise.");
  memory.deleteMemory("preferences/tone.md", paths);
  assert.doesNotMatch(memory.getIndex(paths).content, /Tone/);
});
