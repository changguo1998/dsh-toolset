import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendTurn,
  bootPackage,
  captureInjections,
  injectionText,
  waitFor,
} from "./harness.ts";

test("symbol_normalizer 展示层归一与回合审查在真实宿主生效", async (t) => {
  const host = await bootPackage("symbol-normalizer", {
    extraPackages: ["rule-engine"],
    patch: (home) =>
      `- id: rule-engine\n  config:\n    stateDir: ${JSON.stringify(`${home}/rule-engine`)}\n`,
  });
  t.after(async () => host.dispose());

  const service = host.ctx.get("symbolNormalizer") as {
    normalize(text: string): { text: string; replacedCount: number };
  };
  const normalized = service.normalize("✔ 完成 ❌ 失败");
  assert.equal(normalized.text, "✓ 完成 ✗ 失败");
  assert.equal(normalized.replacedCount, 2);

  const agent = await host.createAgent("e2e-symbol");
  t.after(async () => agent.dispose());
  const delivered = captureInjections(agent.agent);
  appendTurn(agent.agent, "本次完成 ✔");
  await waitFor(() => delivered.length > 0, "未收到符号规范提醒");
  assert.match(injectionText(delivered[0]?.message), /符号/);
});
