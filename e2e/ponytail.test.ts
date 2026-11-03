import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendStepEnd,
  bootPackage,
  captureInjections,
  injectionText,
  waitFor,
} from "./harness.ts";

test("ponytail 在步边界把决策阶梯注入给模型", async (t) => {
  const host = await bootPackage("ponytail", {
    extraPackages: ["rule-engine"],
    patch: (home) =>
      `- id: rule-engine\n  config:\n    stateDir: ${JSON.stringify(`${home}/rule-engine`)}\n`,
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-ponytail");
  t.after(async () => agent.dispose());
  const delivered = captureInjections(agent.agent);

  appendStepEnd(agent.agent);
  await waitFor(() => delivered.length > 0, "未收到 ponytail 注入");
  const text = injectionText(delivered[0]?.message);
  assert.match(text, /阶梯|懒|最小改动/);
});
