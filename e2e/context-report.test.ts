import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("context_report 在真实宿主里列出会话并给出状态", async (t) => {
  const host = await bootPackage("context-report");
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-context");
  t.after(async () => agent.dispose());

  const state = await host.callTool("context_report", {
    action: "state",
    session_id: "e2e-context",
  });
  assert.equal(state.isError, false, textOf(state));

  const list = await host.callTool("context_report", { action: "list" });
  assert.equal(list.isError, false, textOf(list));
  assert.match(textOf(list), /e2e-context/);
});
