import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendTurn,
  bootPackage,
  captureInjections,
  injectionText,
  waitFor,
} from "./harness.ts";

test("term_check 在真实回合里发现旧称并投递更正提示", async (t) => {
  const host = await bootPackage("term-check", {
    extraPackages: ["rule-engine"],
    patch: (home) =>
      [
        `- id: rule-engine`,
        `  config:`,
        `    stateDir: ${JSON.stringify(`${home}/rule-engine`)}`,
        "",
      ].join("\n"),
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-term");
  t.after(async () => agent.dispose());
  const delivered = captureInjections(agent.agent);

  // 「返回体」是术语表里的无条件旧称，应当更正为「回执」
  appendTurn(agent.agent, "这里返回体的字段说明还需要补一下。");
  await waitFor(() => delivered.length > 0, "未收到术语更正提示");

  const text = injectionText(delivered[0]?.message);
  assert.match(text, /禁止术语/);
  assert.match(text, /返回体/);
  assert.match(text, /回执/);
});
