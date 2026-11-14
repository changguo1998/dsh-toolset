import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("plan_start 经 task-engine 建出三段树: 三段挂根 + 顺序强制拦越序", async (t) => {
  const host = await bootPackage("plan-mode", {
    extraPackages: ["task-engine", "clock-base", "tool-surface"],
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-plan");
  t.after(async () => agent.dispose());

  const started = await host.callTool("plan_start", {}, { agent: agent.agent });
  assert.equal(started.isError, false, textOf(started));
  const value = started.value as { ok?: boolean; nodes?: string[] } | undefined;
  assert.equal(value?.ok, true, textOf(started));
  assert.equal(value?.nodes?.length, 3, "三段节点都建出来了");

  const tree = await host.callTool("task_status", {}, { agent: agent.agent });
  assert.equal(tree.isError, false, textOf(tree));
  assert.match(textOf(tree), /"title": "探索"/);
  assert.match(textOf(tree), /"title": "实施"/);

  // 顺序强制：跳过探索直接对计划段动手会被 task-engine 拒绝
  const early = await host.callTool(
    "task_stop",
    { task_id: `${value?.nodes?.[1] ?? ""}` },
    { agent: agent.agent },
  );
  assert.equal(early.isError, false, textOf(early));
  const denied = early.value as { ok?: boolean; feedback?: string } | undefined;
  assert.equal(denied?.ok, false, textOf(early));
  assert.match(denied?.feedback ?? "", /受顺序强制约束/);
});
