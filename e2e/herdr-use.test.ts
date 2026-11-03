import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("herdr_use 在真实宿主里注册终端面并列出空清单", async (t) => {
  const host = await bootPackage("herdr-use");
  t.after(async () => host.dispose());

  const names = host.tools().map((tool) => tool.name);
  assert.ok(names.includes("herdr_run"), names.join(", "));
  assert.ok(names.includes("herdr_create"), names.join(", "));

  const agent = await host.createAgent("e2e-herdr-use");
  t.after(async () => agent.dispose());
  const listed = await host.callTool("herdr_list", {}, { agent: agent.agent });
  assert.equal(listed.isError, false, textOf(listed));
  assert.match(textOf(listed), /0 个终端|还没有终端/);
});
