import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("preference_add 落候选并写入偏好账簿", async (t) => {
  const host = await bootPackage("preference-analysis", {
    extraPackages: ["memory-base", "rule-engine"],
  });
  t.after(async () => host.dispose());

  const added = await host.callTool("preference_add", {
    text: "回复尽量先给结论",
  });
  assert.equal(added.isError, false, textOf(added));

  const listed = await host.callTool("preference_list", {
    status: "candidate",
  });
  assert.equal(listed.isError, false, textOf(listed));
  assert.match(textOf(listed), /先给结论/);

  const ledger = join(host.home, "preference-analysis", "ledger.json");
  assert.equal(existsSync(ledger), true, ledger);
  assert.match(readFileSync(ledger, "utf8"), /先给结论/);
});
