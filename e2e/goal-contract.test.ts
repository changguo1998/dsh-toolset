import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("goal_contract_draft 在真实宿主里起草 Done-when 契约", async (t) => {
  const host = await bootPackage("goal-contract");
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-goal-contract");
  t.after(async () => agent.dispose());

  const result = await host.callTool(
    "goal_contract_draft",
    {
      objective: "端到端验证契约起草",
      clauses_text: "契约文本可读 → echo ok",
      max_goal_rounds: 3,
    },
    { agent: agent.agent },
  );
  assert.equal(result.isError, false, textOf(result));
  assert.match(textOf(result), /Done-when|契约|目标/, textOf(result));
});
