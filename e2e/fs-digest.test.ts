import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import { bootPackage, tempPath, textOf } from "./harness.ts";

test("fs_digest 在真实宿主上给出 Markdown 大纲", async (t) => {
  const host = await bootPackage("fs-digest");
  t.after(async () => host.dispose());

  const path = tempPath(host.home, "doc.md");
  writeFileSync(path, "# 标题\n\n正文\n\n## 小节\n\n- 条目\n");

  const result = await host.callTool("fs_digest", { path, mode: "outline" });
  assert.equal(result.isError, false, textOf(result));
  const text = textOf(result);
  assert.match(text, /标题/);
  assert.match(text, /小节/);
  assert.match(text, /L1/);
});
