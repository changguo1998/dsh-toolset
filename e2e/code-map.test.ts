import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("code_map 建索引后报告符号与引用", async (t) => {
  const host = await bootPackage("code-map");
  t.after(async () => host.dispose());

  const root = join(host.home, "src");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "lib.ts"),
    "export function greet() { return 1; }\n",
  );
  writeFileSync(
    join(root, "main.ts"),
    'import { greet } from "./lib.ts";\ngreet();\n',
  );

  const indexed = await host.callTool("code_map", { action: "index", root });
  assert.equal(indexed.isError, false, textOf(indexed));

  const callers = await host.callTool("code_map", {
    action: "callers",
    symbol: "greet",
  });
  assert.equal(callers.isError, false, textOf(callers));
  assert.match(textOf(callers), /main\.ts/);
});
