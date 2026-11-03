import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { bootPackage, tempPath, textOf } from "./harness.ts";

test("ast_query 搜索与 ast_replace 写回真实文件", async (t) => {
  const host = await bootPackage("ast-tools");
  t.after(async () => host.dispose());

  const path = tempPath(host.home, "code.ts");
  writeFileSync(path, "const value = 1;\nconsole.log(value);\n");

  const query = await host.callTool("ast_query", {
    action: "search",
    pattern: "console.log($ARG)",
    language: "ts",
    path,
  });
  assert.equal(query.isError, false, textOf(query));
  assert.match(textOf(query), /console\.log/);

  const replace = await host.callTool("ast_replace", {
    pattern: "console.log($ARG)",
    replacement: "logger.info($ARG)",
    language: "ts",
    path,
    write: true,
  });
  assert.equal(replace.isError, false, textOf(replace));
  assert.match(readFileSync(path, "utf8"), /logger\.info\(value\)/);
});
