import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { bootPackage, tempPath, textOf } from "./harness.ts";

test("hash_edit 按锚点改行并落盘", async (t) => {
  const host = await bootPackage("hash-edit");
  t.after(async () => host.dispose());

  const path = tempPath(host.home, "target.txt");
  writeFileSync(path, "第一行\n第二行\n第三行\n");

  const read = await host.callTool("hash_read", { path });
  assert.equal(read.isError, false, textOf(read));
  const lines = (
    JSON.parse(textOf(read)) as { hashlines: { line: number; hash: string }[] }
  ).hashlines;
  const anchor = lines.find((line) => line.line === 2);
  assert.ok(anchor, `hash_read 未返回第 2 行锚点：\n${textOf(read)}`);

  const edited = await host.callTool("hash_edit", {
    path,
    edits: [
      {
        set_line: {
          anchor: `${anchor.line}:${anchor.hash}`,
          new_text: "改过的第二行",
        },
      },
    ],
  });
  assert.equal(edited.isError, false, textOf(edited));
  assert.equal(readFileSync(path, "utf8"), "第一行\n改过的第二行\n第三行\n");
});
