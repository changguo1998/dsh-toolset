import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("security_guard 在真实宿主里拦下 sudo 并写入判定记录", async (t) => {
  const host = await bootPackage("security-guard");
  t.after(async () => host.dispose());

  const denied = await host.callTool("bash", { command: "sudo id" });
  assert.equal(denied.isError, true, textOf(denied));
  assert.match(textOf(denied), /已拦截|sudo/);

  const guard = host.ctx.get("guard") as {
    recent(): { toolName?: string; denied?: boolean }[];
  };
  const records = guard.recent();
  assert.ok(records.length > 0, "判定记录为空");
  assert.ok(
    records.some((record) => record.toolName === "bash"),
    JSON.stringify(records.slice(0, 3)),
  );
});
