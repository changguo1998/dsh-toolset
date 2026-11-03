import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("tool_consult 咨询后把命中工具揭示到当前会话", async (t) => {
  const host = await bootPackage("tool-consult", {
    extraPackages: ["fs-digest"],
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-consult");
  t.after(async () => agent.dispose());

  const tools = host.ctx.tools as {
    schemas(agent?: unknown): { name: string }[];
  };
  const before = tools.schemas(agent.agent).map((tool) => tool.name);
  assert.ok(before.includes("consult_tools"), before.join(", "));
  assert.ok(
    !before.includes("fs_digest"),
    `咨询前不应可见 fs_digest：${before.join(", ")}`,
  );

  const consulted = await host.callTool(
    "consult_tools",
    { query: "按结构摘要读取文件大纲", limit: 5 },
    { agent: agent.agent },
  );
  assert.equal(consulted.isError, false, textOf(consulted));
  assert.match(textOf(consulted), /fs_digest/);

  const after = tools.schemas(agent.agent).map((tool) => tool.name);
  assert.ok(after.includes("fs_digest"), after.join(", "));
});
