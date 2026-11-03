import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("rule_add 登记的规则可被 rule_list 列出并在 rule_test 命中", async (t) => {
  const host = await bootPackage("rule-engine");
  t.after(async () => host.dispose());

  const added = await host.callTool("rule_add", {
    id: "e2e-rule",
    text: "端到端规则命中",
    match: { keywords: ["端到端"] },
  });
  assert.equal(added.isError, false, textOf(added));

  const listed = await host.callTool("rule_list", {});
  assert.equal(listed.isError, false, textOf(listed));
  assert.match(textOf(listed), /e2e-rule/);

  const tested = await host.callTool("rule_test", { text: "这是端到端用例" });
  assert.equal(tested.isError, false, textOf(tested));
  assert.match(textOf(tested), /e2e-rule|命中/);
});
