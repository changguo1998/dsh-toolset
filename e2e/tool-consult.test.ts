import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("tool-consult：短清单常驻, 条件工具隐藏, 揭示不改声明", async (t) => {
  const host = await bootPackage("tool-surface", {
    extraPackages: ["tool-consult", "fs-digest"],
  });
  t.after(async () => host.dispose());

  const tools = host.ctx.tools as {
    schemas(agent?: unknown): Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
    register(definition: unknown, options?: unknown): () => void;
  };

  // 真实宿主里的条件工具：白名单外，应被静态 deny 从模型面移除。
  const hiddenName = "e2e_when_hidden";
  const disposeHidden = tools.register(
    {
      name: hiddenName,
      description: "端到端条件工具。",
      parameters: { type: "object", properties: {} },
      execute: () => ({}),
      output: {
        schema: { type: "object", additionalProperties: true, properties: {} },
        render: () => [],
      },
    },
    { when: () => false },
  );
  t.after(() => disposeHidden());

  const agent = await host.createAgent("e2e-consult");
  t.after(async () => agent.dispose());

  const before = tools.schemas(agent.agent);
  const names = before.map((tool) => tool.name);
  assert.ok(names.includes("consult_tools"), names.join(", "));
  assert.ok(
    names.includes("fs_digest"),
    `fs_digest 应以短定义常驻: ${names.join(", ")}`,
  );
  assert.equal(
    names.includes(hiddenName),
    false,
    "白名单外条件工具应完全不可见",
  );

  const shortView = before.find((tool) => tool.name === "fs_digest");
  assert.ok(shortView);
  assert.match(String(shortView.description), /tool_consult/);
  assert.equal(shortView.parameters?.["additionalProperties"], true);

  // 未揭示：派发被门禁拒绝。
  const denied = await host.callTool(
    "fs_digest",
    { path: "x.md", mode: "outline" },
    { agent: agent.agent },
  );
  assert.equal(denied.isError, true);
  assert.equal(denied.error?.info?.code, "TOOL_NOT_REVEALED", textOf(denied));

  const consulted = await host.callTool(
    "consult_tools",
    { names: ["fs_digest"] },
    { agent: agent.agent },
  );
  assert.equal(consulted.isError, false, textOf(consulted));
  assert.match(textOf(consulted), /fs_digest/);

  const after = tools.schemas(agent.agent);
  assert.deepEqual(after, before, "揭示不得改变工具声明");

  const revealed = await host.callTool(
    "fs_digest",
    { path: "x.md", mode: "outline" },
    { agent: agent.agent },
  );
  assert.notEqual(
    revealed.error?.info?.code,
    "TOOL_NOT_REVEALED",
    textOf(revealed),
  );

  // 第二个代理：条件工具仍然不可见，fs_digest 仍被门禁拒绝。
  const second = await host.createAgent("e2e-consult-second");
  t.after(async () => second.dispose());
  const secondNames = tools.schemas(second.agent).map((tool) => tool.name);
  assert.equal(secondNames.includes(hiddenName), false);
  const deniedSecond = await host.callTool(
    "fs_digest",
    { path: "x.md", mode: "outline" },
    { agent: second.agent },
  );
  assert.equal(
    deniedSecond.error?.info?.code,
    "TOOL_NOT_REVEALED",
    textOf(deniedSecond),
  );
});
