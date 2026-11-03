import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { bootPackage, tempPath, textOf } from "./harness.ts";

test("md_logic 按节替换并落盘", async (t) => {
  const host = await bootPackage("md-logic");
  t.after(async () => host.dispose());

  const path = tempPath(host.home, "doc.md");
  writeFileSync(path, "# 标题\n\n旧正文\n\n## 小节\n\n小节正文\n");

  const structure = await host.callTool("md_logic", {
    action: "structure",
    path,
  });
  assert.equal(structure.isError, false, textOf(structure));
  assert.match(textOf(structure), /标题/);

  const section = textOf(structure)
    .split("\n")
    .find((line) => line.includes("标题"));
  assert.ok(section, `structure 未返回标题节：\n${textOf(structure)}`);
  const range = section.match(/L(\d+)-(\d+)/);
  assert.ok(range, `structure 节行范围缺失：${section}`);

  const replaced = await host.callTool("md_logic", {
    action: "replace",
    path,
    edits: [
      {
        heading: "标题",
        start_line: Number(range[1]),
        end_line: Number(range[2]),
        content: "# 标题\n\n新正文\n\n## 小节\n\n小节正文\n",
      },
    ],
  });
  assert.equal(replaced.isError, false, textOf(replaced));
  assert.match(readFileSync(path, "utf8"), /新正文/);
});
