import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("flow_track 写流程记录后可读状态, 服务面给出按选中派生的开关与摘要", async (t) => {
  const host = await bootPackage("flow-track", {
    extraPackages: [
      "memory-base",
      "session-paths",
      "rule-engine",
      "flow-arbiter",
    ],
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

  // 激活由 flow-arbiter 选中决定（/flow-track 只留 status 查看, 不再有开关）
  const selected = await host.callTool(
    "flow_select",
    { flow: "standard" },
    { agent: agent.agent },
  );
  assert.equal(selected.isError, false, textOf(selected));

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
  // 工具层 isError=false 不代表写入成功（memory 不可用时 payload 是 ok:false）, 必须查 payload
  const payload = recorded.value as { ok?: boolean } | undefined;
  assert.equal(payload?.ok, true, textOf(recorded));
  // 记录必须落在临时 home 的项目库（P 层），不能写进仓库自己的 `.dsh/`
  assert.equal(existsSync(join(host.home, ".dsh", "project.db")), true);

  const status = await host.callTool(
    "flow_status",
    { slug: "e2e-flow" },
    { agent: agent.agent },
  );
  assert.equal(status.isError, false, textOf(status));
  assert.match(textOf(status), /目标/);

  const face = host.ctx.get("flowTrack") as {
    enabled(sessionId?: string): boolean;
    summary(sessionId?: string): {
      enabled: boolean;
      records: readonly { slug: string; stage: string; active: boolean }[];
    };
  };
  const sessionId = (agent.agent as { session?: { id?: string } })?.session?.id;
  assert.equal(typeof sessionId, "string", "agent 应带会话 id");
  assert.equal(face.enabled(sessionId), true, "选中流程后注入开启");
  const summary = face.summary(sessionId);
  assert.equal(summary.enabled, true);
  assert.equal(summary.records[0]?.slug, "e2e-flow");
  assert.equal(summary.records[0]?.stage, "目标");
  assert.equal(summary.records[0]?.active, true);
});

test("flow_start 经 task-engine 建出八阶段树: 八帧挂根 + 顺序强制拦越序", async (t) => {
  const host = await bootPackage("flow-track", {
    extraPackages: ["task-engine", "clock-base", "tool-surface"],
  });
  t.after(async () => host.dispose());

  const agent = await host.createAgent("e2e-start");
  t.after(async () => agent.dispose());

  const started = await host.callTool("flow_start", {}, { agent: agent.agent });
  assert.equal(started.isError, false, textOf(started));
  const value = started.value as { ok?: boolean; nodes?: string[] } | undefined;
  assert.equal(value?.ok, true, textOf(started));
  assert.equal(value?.nodes?.length, 8, "八阶段节点都建出来了");

  const tree = await host.callTool("task_status", {}, { agent: agent.agent });
  assert.equal(tree.isError, false, textOf(tree));
  assert.match(textOf(tree), /"title": "目标"/);
  assert.match(textOf(tree), /"title": "收尾"/);

  // 顺序强制：直接对第二阶段 implement 会被 task-engine 拒绝
  const early = await host.callTool(
    "task_implement",
    { task_id: `${value?.nodes?.[1] ?? ""}`, result: "抢跑" },
    { agent: agent.agent },
  );
  assert.equal(early.isError, false, textOf(early));
  const denied = early.value as { ok?: boolean; feedback?: string } | undefined;
  assert.equal(denied?.ok, false, textOf(early));
  assert.match(denied?.feedback ?? "", /受顺序强制约束/);
});
