import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("task_engine 在真实会话里拆出子任务并回读任务树", async (t) => {
  const host = await bootPackage("task-engine");
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-task");
  t.after(async () => agent.dispose());

  const decomposed = await host.callTool(
    "task_decompose",
    {
      parent_id: "root",
      children: [
        {
          id: "c1",
          title: "子任务一",
          spec: "端到端子任务",
          acceptance: [{ id: "a1", check: "结果可读", level: "human" }],
        },
      ],
    },
    { agent: agent.agent },
  );
  assert.equal(decomposed.isError, false, textOf(decomposed));

  const status = await host.callTool("task_status", {}, { agent: agent.agent });
  assert.equal(status.isError, false, textOf(status));
  assert.match(textOf(status), /c1|子任务一/);
});
