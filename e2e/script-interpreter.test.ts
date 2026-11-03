import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import { bootPackage, tempPath, textOf } from "./harness.ts";

test("script_run 在真实宿主里执行 Python 脚本", async (t) => {
  const host = await bootPackage("script-interpreter");
  t.after(async () => host.dispose());

  const result = await host.callTool("script_run", {
    script: 'print("e2e-ok")',
    description: "端到端冒烟",
  });
  assert.equal(result.isError, false, textOf(result));
  assert.match(textOf(result), /e2e-ok/);
});
