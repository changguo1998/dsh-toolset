import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("coagent 在真实宿主里列出空记录且不改动终端", async (t) => {
  const host = await bootPackage("coagent", {
    extraPackages: ["herdr-use", "session-channel"],
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-coagent");
  t.after(async () => agent.dispose());

  const listed = await host.callTool(
    "coagent",
    { action: "list", probe: "none" },
    { agent: agent.agent },
  );
  assert.equal(listed.isError, false, textOf(listed));
  assert.match(textOf(listed), /\[\]|0|无/);
});
