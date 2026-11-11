import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("flow_track 写流程记录后可读状态, 服务面给出开关与摘要", async (t) => {
  const host = await bootPackage("flow-track", {
    extraPackages: ["memory-base", "session-paths", "rule-engine"],
    patch: (home) =>
      [
        `- id: rule-engine`,
        `  config:`,
        `    stateDir: ${JSON.stringify(`${home}/rule-engine`)}`,
        `- id: flow-track`,
        `  config:`,
        `    enabled: true`,
        "",
      ].join("\n"),
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-flow");
  t.after(async () => agent.dispose());

  const switched = await host.callTool(
    "flow_enable",
    { enabled: true },
    { agent: agent.agent },
  );
  assert.equal(switched.isError, false, textOf(switched));

  const recorded = await host.callTool(
    "flow_record",
    {
      slug: "e2e-flow",
      stage: "目标",
      status: "start",
      body: "端到端写入的流程记录",
    },
    { agent: agent.agent },
  );
  assert.equal(recorded.isError, false, textOf(recorded));
  // 记录必须落在临时 home 的项目库（P 层），不能写进仓库自己的 `.dsh/`
  assert.equal(existsSync(join(host.home, ".dsh", "project.db")), true);

  const status = await host.callTool(
    "flow_status",
    { slug: "e2e-flow" },
    { agent: agent.agent },
  );
  assert.equal(status.isError, false, textOf(status));
  assert.match(textOf(status), /目标/);

  const flow = host.ctx.get("flowTrack") as {
    enabled(): boolean;
    summary(): {
      enabled: boolean;
      records: readonly { slug: string; stage: string; active: boolean }[];
    };
  };
  assert.equal(flow.enabled(), true);
  const summary = flow.summary();
  assert.equal(summary.enabled, true);
  assert.equal(summary.records[0]?.slug, "e2e-flow");
  assert.equal(summary.records[0]?.stage, "目标");
  assert.equal(summary.records[0]?.active, true);
});
