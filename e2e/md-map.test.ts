import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("md_map 建索引后回答谁引用了目标文档", async (t) => {
  const host = await bootPackage("md-map");
  t.after(async () => host.dispose());

  const root = join(host.home, "docs");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.md"), "# A\n\n见 [B](b.md)。\n");
  writeFileSync(join(root, "b.md"), "# B\n\n正文。\n");

  const indexed = await host.callTool("md_map", { action: "index", root });
  assert.equal(indexed.isError, false, textOf(indexed));

  const callers = await host.callTool("md_map", {
    action: "callers",
    path: "b.md",
  });
  assert.equal(callers.isError, false, textOf(callers));
  assert.match(textOf(callers), /a\.md/);
});
