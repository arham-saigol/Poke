import assert from "node:assert/strict";
import test from "node:test";

test("automation validation rejects malformed entries", async () => {
  const { validateAutomations } = await import("../packages/automations/src/index.ts");
  assert.throws(() => validateAutomations([{ name: "" }]));
  const valid = validateAutomations([
    {
      name: "One time",
      description: "Run once",
      enabled: true,
      kind: "one_time",
      schedule: { type: "at", value: new Date().toISOString(), timezone: "UTC" },
      action: { type: "prompt", prompt: "Say hi" },
      createdBy: "user",
      updatedAt: new Date().toISOString()
    }
  ]);
  assert.equal(valid.length, 1);
});
