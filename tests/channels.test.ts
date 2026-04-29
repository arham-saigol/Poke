import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("slash commands update the shared session", async () => {
  const originalPokeHome = process.env.POKE_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "poke-channel-"));
  try {
    process.env.POKE_HOME = home;
    const storage = await import("../packages/storage/src/index.ts");
    const channels = await import("../packages/channels/src/index.ts");
    storage.bootstrapPokeHome({ home });
    const session = await channels.handleSlashCommand("/reasoning medium", "web");
    assert.equal(session.reasoning, "medium");
    assert.equal((await channels.handleSlashCommand("/abort", "web")).status, "aborted");
    assert.notEqual(channels.newSession().id, session.id);
  } finally {
    if (originalPokeHome !== undefined) {
      process.env.POKE_HOME = originalPokeHome;
    } else {
      delete process.env.POKE_HOME;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
