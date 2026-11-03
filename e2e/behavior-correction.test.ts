import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import { bootPackage, tempPath, textOf } from "./harness.ts";

test("behavior_correction 拦下用 bash 看文本并指路专用工具", async (t) => {
  const host = await bootPackage("behavior-correction", {
    extraPackages: ["rule-engine"],
  });
  t.after(async () => host.dispose());

  const file = tempPath(host.home, "note.txt");
  writeFileSync(file, "内容\n");

  const denied = await host.callTool("bash", { command: `cat ${file}` });
  assert.equal(denied.isError, true, textOf(denied));
  assert.match(textOf(denied), /read|专用工具|behavior-correction/i);
});
