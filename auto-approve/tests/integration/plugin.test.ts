import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AUDIT_FILE_NAME } from "../../src/audit.ts";
import { COMMAND_NAME } from "../../src/command.ts";
import { inject, name, provide } from "../../src/index.ts";
import { REVIEW_POLICY } from "../../src/review.ts";
import type { AuditLine } from "../../src/types.ts";
import {
  approvalRequest,
  assemble,
  flushAudit,
  preExecuteExecution,
  requestHeaderEvent,
  sessionOf,
  toolCallEvent,
} from "../assemble.ts";

test("装配: 契约符号齐备, 三个监听器与命令各注册一次, 启动日志带名单计数", () => {
  const a = assemble();
  assert.equal(name, "auto-approve");
  assert.deepEqual(inject, ["approval", "tools"]);
  assert.deepEqual(provide, ["autoApprove"]);
  // 本插件 + 模拟面板 = 2；执行前与会话事件各 1
  assert.equal(a.host.count("approval/request"), 2);
  assert.equal(a.host.count("tools/pre-execute"), 1);
  assert.equal(a.host.count("session/event"), 1);
  assert.equal(a.commands.definitions.length, 1);
  assert.equal(a.commands.definitions[0]?.name, COMMAND_NAME);
  assert.equal(
    a.commands.definitions[0]?.definitionId,
    `auto-approve:${COMMAND_NAME}`,
  );
  assert.match(
    a.commands.definitions[0]?.input?.hint ?? "",
    /clear-fingerprints/,
  );
  assert.match(
    a.host.logs.join("\n"),
    /auto-approve mounted: mode=rules readonly=9/,
  );
  // 未挂 clock 服务时装配期只告警一次
  assert.equal(
    a.host.logs.filter((line) => line.includes("clock 服务不可用")).length,
    1,
  );
  a.dispose();
});

test("服务面: provide 与 get 取到同一份, status 名单计数与配置一致", () => {
  const a = assemble({
    config: {
      allow: {
        commands: { bash: ["^ls$"] },
        paths: { read: ["^/var/log/"] },
      },
      deny: { tools: ["mcp__*"], escalation: { to: ["danger-full-access"] } },
      escalation: { allow: [{ match: "^git", to: ["workspace-write"] }] },
      review: { provider: "p", model: "m" },
    },
  });
  assert.equal(a.host.services.get("autoApprove"), a.service);
  assert.equal(a.host.provided.get("autoApprove"), a.service);
  const status = a.service.status();
  assert.equal(status.enabled, true);
  assert.equal(status.mode, "rules");
  assert.equal(status.configuredMode, "rules");
  assert.equal(status.llmEnabled, false);
  assert.equal(status.llmRoute, "p/m");
  assert.equal(status.readonlyTools, 9);
  assert.equal(status.allowRules, 2);
  assert.equal(status.denyRules, 2);
  assert.equal(status.upgradeRules, 1);
  assert.equal(status.fingerprints, 0);
  assert.equal(status.forms, 0);
  assert.equal(status.audit.sessionWritable, true);
  assert.equal(a.service.recent(5).length, 0);
  assert.deepEqual(a.service.forms(), []);
  a.dispose();
});

test("approval/request: 只读类放行, 拒绝名单拒绝, 灰区交下一位 (面板)", async () => {
  const a = assemble({ config: { deny: { tools: ["mcp__*"] } } });
  assert.equal(
    await a.approval(approvalRequest(a, { toolName: "read", callId: "r1" })),
    "allowed-once",
  );
  assert.equal(a.panel.calls, 0, "命中即裁定, 不调面板");

  assert.equal(
    await a.approval(
      approvalRequest(a, { toolName: "mcp__figma__read", callId: "m1" }),
    ),
    "rejected",
  );
  assert.equal(a.panel.calls, 0, "拒绝名单也不调面板");

  assert.equal(
    await a.approval(approvalRequest(a, { callId: "b1" })),
    "rejected",
    "名单外的调用由面板裁定",
  );
  assert.equal(a.panel.calls, 1);
  a.dispose();
});

test("approval/request: 信号已中断回 cancelled; 下一位抛错回 unavailable", async () => {
  const a = assemble();
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await a.approval(
      approvalRequest(a, { toolName: "read", signal: controller.signal }),
    ),
    "cancelled",
  );
  assert.equal(a.panel.calls, 0, "中断的请求不做自动裁定也不交面板");

  a.panel.behavior = "throw";
  assert.equal(
    await a.approval(approvalRequest(a, { callId: "b1" })),
    "unavailable",
  );
  assert.equal(a.panel.calls, 1);
  a.dispose();
});

test("tools/pre-execute: 拒绝名单产出 canonical deny, 其余原样交下一位", async () => {
  const a = assemble({ config: { deny: { tools: ["mcp__*"] } } });
  const denied = await a.preExecute(
    preExecuteExecution(a, { name: "mcp__figma__read", callId: "m1" }),
  );
  assert.equal(denied.kind, "deny");
  assert.match(
    (denied as { reason: string }).reason,
    /auto-approve 拒绝了工具 "mcp__figma__read"/,
  );
  assert.equal(a.toolsNext.calls, 0, "拒绝名单命中不交下一位");

  const passed = await a.preExecute(preExecuteExecution(a, { name: "read" }));
  assert.deepEqual(passed, { kind: "allow" });
  assert.equal(a.toolsNext.calls, 1, "未命中不提前放行, 交下一位");

  const disabled = assemble({
    config: { enabled: false, deny: { tools: ["mcp__*"] } },
  });
  const inert = await disabled.preExecute(
    preExecuteExecution(disabled, { name: "mcp__figma__read", callId: "m2" }),
  );
  assert.deepEqual(inert, { kind: "allow" }, "enabled: false 时不拦");
  disabled.dispose();
  a.dispose();
});

test("两处裁定共用参数表: pre-execute 记录的参数供审批层命中命令白名单", async () => {
  const a = assemble({
    config: { allow: { commands: { bash: ["^git status\\b"] } } },
  });
  await a.preExecute(
    preExecuteExecution(a, {
      arguments: '{"command":"git status"}',
      callId: "c1",
    }),
  );
  assert.equal(
    await a.approval(approvalRequest(a, { callId: "c1" })),
    "allowed-once",
  );
  assert.equal(a.panel.calls, 0);
  a.dispose();
});

test("事件消费者: 工具调用与请求头进入会话观测面 (参数反查 + 模型路由)", async () => {
  const a = assemble({
    config: {
      mode: "rules+llm",
      allow: { commands: { bash: ["^git status\\b"] } },
    },
  });
  const session = sessionOf(a);
  a.sessionEvent(session, requestHeaderEvent("deepseek", "deepseek-flash"));
  a.sessionEvent(
    session,
    toolCallEvent("c7", "bash", '{"command":"git status"}'),
  );
  assert.equal(
    await a.approval(approvalRequest(a, { callId: "c7" })),
    "allowed-once",
    "参数来自 session/event 的 tool/call",
  );
  // 观测不到的 callId: 取不到参数, 白名单不生效, 落面板
  assert.equal(
    await a.approval(approvalRequest(a, { callId: "c8" })),
    "rejected",
  );
  assert.equal(a.panel.calls, 1);
  a.dispose();
});

test("审计双落点: 会话 JSONL 与 memory-base project 层同形且不记参数原文", async () => {
  const a = assemble();
  // 先让会话观测面记下 cwd：项目那份审计行的 project 字段取自它
  a.sessionEvent(sessionOf(a), toolCallEvent("c0", "read", "{}"));
  await a.approval(
    approvalRequest(a, { toolName: "read", callId: "r1", reason: "只读" }),
  );
  await flushAudit();
  const rows = readFileSync(join(a.root, "s1", AUDIT_FILE_NAME), "utf8")
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row) as AuditLine);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row?.sessionId, "s1");
  assert.equal(row?.toolName, "read");
  assert.equal(row?.outcome, "allowed-once");
  assert.equal(row?.source, "readonly");
  assert.equal(row?.ruleId, "readonly:read");
  assert.equal(row?.mode, "rules");
  assert.equal("arguments" in (row ?? {}), false, "审计行不含参数原文");
  assert.equal(a.service.recent(5).length, 1);

  assert.equal(a.memory.kinds.length, 1);
  assert.deepEqual(a.memory.kinds[0], {
    kind: "approval_audit",
    writableTiers: ["project"],
  });
  const put = a.memory.puts[0] as {
    content: string;
    tier: string;
    project?: string;
    title?: string;
    source?: { label?: string; ref?: string };
  };
  assert.equal(put.tier, "project");
  assert.equal(put.project, a.project, "项目名取自会话 cwd");
  assert.match(put.title ?? "", /^auto-approve s1 /);
  assert.deepEqual(put.source, {
    kind: "manual",
    label: "auto-approve",
    ref: "r1",
  });
  assert.deepEqual(JSON.parse(put.content), row);
  a.dispose();
});

test("LLM 灰区: 审查提示注入 ENVIRONMENT / PROJECT_INSTRUCTIONS / PENDING_ACTION", async () => {
  const a = assemble({
    config: {
      mode: "rules+llm",
      review: { provider: "deepseek", model: "deepseek-flash" },
    },
  });
  writeFileSync(
    join(a.project, "AGENTS.md"),
    "项目约束: 不要动生产库\n",
    "utf8",
  );
  const session = sessionOf(a);
  a.sessionEvent(
    session,
    toolCallEvent("c3", "bash", '{"command":"pg_dump prod"}'),
  );
  assert.equal(
    await a.approval(
      approvalRequest(a, { callId: "c3", reason: "生产库只读查询" }),
    ),
    "allowed-once",
  );
  assert.equal(a.llm.calls.length, 1);
  const call = a.llm.calls[0];
  assert.equal(call?.provider, "deepseek");
  assert.equal(call?.model, "deepseek-flash");
  assert.equal(call?.temperature, 0);
  assert.equal(call?.system, REVIEW_POLICY);
  const text = call?.messages[0]?.content[0]?.text ?? "";
  assert.match(text, /^ENVIRONMENT/);
  assert.match(text, new RegExp(`"cwd":"${a.project}"`));
  assert.match(text, /PROJECT_INSTRUCTIONS/);
  assert.match(text, /项目约束: 不要动生产库/);
  assert.match(text, /AGENTS\.md/);
  assert.match(text, /FILTERED_HISTORY/);
  assert.match(text, /PENDING_ACTION/);
  assert.match(text, /pg_dump prod/);
  assert.match(text, /生产库只读查询/);
  const [row] = a.service.recent(1);
  assert.equal(row?.source, "llm");
  assert.equal(row?.reviewerModel, "deepseek/deepseek-flash");
  a.dispose();
});

test("命令面: status / mode / log / clear-fingerprints / learn 的投影文本", async () => {
  const a = assemble();
  const status = await a.commands.invoke();
  assert.equal(status.kind, "success");
  assert.match(status.text ?? "", /auto-approve: 已启用/);
  assert.match(status.text ?? "", /模式: rules（配置默认 rules）/);

  const mode = await a.commands.invoke("mode all");
  assert.equal(mode.kind, "success");
  assert.match(mode.text ?? "", /模式已切到 all/);
  assert.equal(a.service.status().mode, "all", "运行态立即生效");

  const log = await a.commands.invoke("log 3");
  assert.match(log.text ?? "", /还没有自动裁定记录/);

  const cleared = await a.commands.invoke("clear-fingerprints");
  assert.match(cleared.text ?? "", /已清空 0 条会话指纹/);

  const forms = await a.commands.invoke("learn list");
  assert.match(forms.text ?? "", /没有学来的形态/);

  const off = await a.commands.invoke("learn off");
  assert.equal(off.kind, "success");
  assert.equal(a.service.status().learnEnabled, false);
  const on = await a.commands.invoke("learn on");
  assert.equal(on.kind, "success");
  assert.equal(a.service.status().learnEnabled, true);

  const undoMissing = await a.commands.invoke("learn undo");
  assert.equal(undoMissing.kind, "error");
  assert.match(undoMissing.text ?? "", /用法/);
  const undoUnknown = await a.commands.invoke("learn undo abcdef0123456789");
  assert.match(undoUnknown.text ?? "", /没有匹配/);
  const clearedForms = await a.commands.invoke("learn clear");
  assert.match(clearedForms.text ?? "", /已清空 0 条学来的形态/);

  const badMode = await a.commands.invoke("mode yolo");
  assert.equal(badMode.kind, "error");
  assert.match(badMode.text ?? "", /用法: \/autoapprove mode/);
  const unknown = await a.commands.invoke("bogus");
  assert.equal(unknown.kind, "error");
  assert.match(unknown.text ?? "", /未知子命令: bogus/);
  a.dispose();
});

test("命令与监听器的生命周期: dispose 后全部撤销, 请求直接落面板", async () => {
  const a = assemble();
  assert.equal(a.commands.disposed, 0);
  a.dispose();
  assert.equal(a.host.count("tools/pre-execute"), 0);
  assert.equal(a.host.count("session/event"), 0);
  assert.equal(a.host.count("approval/request"), 1, "只剩模拟面板");
  assert.equal(a.commands.disposed, 1, "命令 disposer 被调用");
  assert.equal(
    await a.approval(approvalRequest(a, { toolName: "read", callId: "r1" })),
    "rejected",
  );
  assert.equal(a.panel.calls, 1);
});

test("commands 服务缺席: 不注册命令, 裁定链照常", async () => {
  const a = assemble({ withCommands: false });
  assert.equal(a.commands.definitions.length, 0);
  assert.equal(
    await a.approval(approvalRequest(a, { toolName: "read", callId: "r1" })),
    "allowed-once",
  );
  a.dispose();
});
