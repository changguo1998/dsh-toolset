import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendTurn,
  bootPackage,
  captureInjections,
  injectionText,
  waitFor,
} from "./harness.ts";

test("md_table_check 在真实回合里发现列数不一致并投递修正提示", async (t) => {
  const host = await bootPackage("md-table-check", {
    extraPackages: ["rule-engine"],
    patch: (home) =>
      [
        `- id: rule-engine`,
        `  config:`,
        `    stateDir: ${JSON.stringify(`${home}/rule-engine`)}`,
        `- id: md-table-check`,
        `  config:`,
        `    enabled: true`,
        "",
      ].join("\n"),
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-md-table");
  t.after(async () => agent.dispose());
  const delivered = captureInjections(agent.agent);

  appendTurn(agent.agent, "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |");
  await waitFor(() => delivered.length > 0, "未收到表格列数修正提示");
  const text = injectionText(delivered[0]?.message);
  assert.match(text, /表格列数/);
  assert.match(text, /第 3 行/);
});
