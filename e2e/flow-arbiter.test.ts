import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("流程仲裁: 选中才放行, 选别的入口被拒, 切流程后另一个入口通过", async (t) => {
  const host = await bootPackage("flow-arbiter", {
    extraPackages: [
      "flow-track",
      "plan-mode",
      "task-engine",
      "clock-base",
      "tool-surface",
    ],
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-arbiter");
  t.after(async () => agent.dispose());

  // 未选中任何流程：两个入口都被拒
  const noSelection = await host.callTool(
    "flow_start",
    {},
    { agent: agent.agent },
  );
  assert.equal(noSelection.isError, true, textOf(noSelection));
  assert.match(textOf(noSelection), /未选中流程/);

  // 选中 standard → flow_start 通过
  const selected = await host.callTool(
    "flow_select",
    { flow: "standard" },
    { agent: agent.agent },
  );
  assert.equal(selected.isError, false, textOf(selected));
  const started = await host.callTool("flow_start", {}, { agent: agent.agent });
  assert.equal(started.isError, false, textOf(started));
  const value = started.value as { ok?: boolean; nodes?: string[] } | undefined;
  assert.equal(value?.ok, true, textOf(started));
  assert.equal(value?.nodes?.length, 8);

  // 切到 plan → plan_start 通过, flow_start 被拒（选中了别的流程）
  const switched = await host.callTool(
    "flow_select",
    { flow: "plan" },
    { agent: agent.agent },
  );
  assert.equal(switched.isError, false, textOf(switched));
  const denied = await host.callTool("flow_start", {}, { agent: agent.agent });
  assert.equal(denied.isError, true, textOf(denied));
  assert.match(textOf(denied), /plan 模式三段/);

  // 挂到已建出的首个节点下建 plan 三段（避开「根已展开」）
  const plan = await host.callTool(
    "plan_start",
    { parent_id: value?.nodes?.[0] ?? "" },
    { agent: agent.agent },
  );
  assert.equal(plan.isError, false, textOf(plan));
  assert.equal((plan.value as { ok?: boolean })?.ok, true, textOf(plan));
});
