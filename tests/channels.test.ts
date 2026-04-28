import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("slash commands update the shared session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "poke-channel-"));
  process.env.POKE_HOME = home;
  const storage = await import("../packages/storage/src/index.ts");
  const channels = await import("../packages/channels/src/index.ts");
  storage.bootstrapPokeHome({ home });
  const session = channels.handleSlashCommand("/reasoning medium", "web");
  assert.equal(session.reasoning, "medium");
  assert.equal(channels.handleSlashCommand("/abort", "web").status, "aborted");
  assert.notEqual(channels.newSession().id, session.id);
});
