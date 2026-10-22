import { test } from "node:test";
import assert from "node:assert/strict";

import { apply } from "../src/main.ts";
import { createFakeHost, type FakeToolSchema } from "./fake-host.ts";

const NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "todo_write",
  "ask_user_question",
  "skill",
  "task_decompose",
  "task_status",
  "rule_add",
  "rule_update",
  "session_channel",
  "channel_delegate",
];

function schemas(): FakeToolSchema[] {
  return NAMES.map((name) => ({
    name,
    description: `${name} 工具：用于 ${name} 场景。`,
    parameters: { properties: { action: { type: "string" } } },
  }));
}

function consultOf(host: ReturnType<typeof createFakeHost>) {
  const definition = host.registered.get("consult_tools");
  assert.ok(definition?.execute, "consult_tools 应已注册");
  return definition.execute as (args: Record<string, unknown>) => Promise<{ text: string }>;
}

const CORE = [
  "ask_user_question",
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "skill",
  "todo_write",
  "write",
];

test("session 档：初始遮罩 9 核心 + 揭示替换 + 拦截文案", async () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t1-agent" });
  host.emit("agent/created", { agent });

  assert.equal(host.registered.has("consult_tools"), true);
  assert.deepEqual(host.activeMask(), CORE);

  const execute = consultOf(host);
  const result = await execute({ query: "跨会话发消息" });
  assert.match(result.text, /已揭示/);
  assert.equal(host.restrictCalls.length, 2);
  assert.equal(host.restrictCalls[0]?.disposed, true, "旧遮罩应被撤销（替换式）");
  const mask = host.activeMask() ?? [];
  assert.ok(mask.includes("session_channel"));
  assert.ok(mask.length > CORE.length);

  const deny = agent.emit("tools/pre-execute", { name: "rule_add" }, () => ({ kind: "allow" }));
  assert.deepEqual(deny, {
    kind: "deny",
    reason: '工具 "rule_add" 当前不可见（被 tool-consult 管理）。'
      + '调用 consult_tools（names: ["rule_add"]）揭示后即可调用；'
      + "也可以 query 描述用途来检索。",
  });

  const allow = agent.emit("tools/pre-execute", { name: "bash" }, () => ({ kind: "allow" }));
  assert.deepEqual(allow, { kind: "allow" });

  host.dispose();
});

test("session 档：超上限拒绝新增且不抽走已授权", async () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, { maxRevealed: 1 });
  const agent = host.addAgent({ id: "t2-agent" });
  host.emit("agent/created", { agent });

  const execute = consultOf(host);
  const first = await execute({ names: ["task_decompose"] });
  assert.match(first.text, /已揭示/);
  const before = host.activeMask();

  const second = await execute({ names: ["task_status"] });
  assert.match(second.text, /已达新增揭示上限/);
  assert.deepEqual(host.activeMask(), before);
  assert.ok(!(host.activeMask() ?? []).includes("task_status"));
  assert.ok((host.activeMask() ?? []).includes("task_decompose"));

  host.dispose();
});

test("turn 档：回合末收敛，宽限保留本回合揭示项", async () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, { revealScope: "turn", maxRevealed: 1 });
  const agent = host.addAgent({ id: "t3-agent" });
  host.emit("agent/created", { agent });
  const execute = consultOf(host);

  await execute({ names: ["rule_add"] });
  assert.ok((host.activeMask() ?? []).includes("rule_add"));

  host.emit("session/event", { id: agent.id }, { type: "turn/start", data: { turn: 1 } });
  await execute({ names: ["rule_update"] });
  host.emit("session/event", { id: agent.id }, { type: "turn/end", data: { turn: 1 } });

  const mask = host.activeMask() ?? [];
  assert.ok(mask.includes("rule_update"), "本回合揭示项享受宽限");
  assert.ok(!mask.includes("rule_add"), "上一回合的项应按容量收敛");

  host.dispose();
});

test("turn 档：pin 的项跨回合保留", async () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, { revealScope: "turn", maxRevealed: 1, maxPinned: 3 });
  const agent = host.addAgent({ id: "t4-agent" });
  host.emit("agent/created", { agent });
  const execute = consultOf(host);

  await execute({ names: ["rule_add"], pin: true });
  await execute({ names: ["rule_update"] });
  host.emit("session/event", { id: agent.id }, { type: "turn/start", data: { turn: 1 } });
  host.emit("session/event", { id: agent.id }, { type: "turn/end", data: { turn: 1 } });

  const mask = host.activeMask() ?? [];
  assert.ok(mask.includes("rule_add"), "钉住项不参与收敛");
  assert.ok(!mask.includes("rule_update"));

  host.dispose();
});

test("applyTo=roots：子代理不遮、不注册咨询工具", () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  const child = host.addAgent({ id: "t5-child", header: { origin: "subagent" } });
  host.emit("agent/created", { agent: child });

  assert.equal(host.restrictCalls.length, 0);
  assert.equal(host.registered.size, 0);

  host.dispose();
});

test("无 agent 作用域：回退不遮并告警", () => {
  const host = createFakeHost({ schemas: schemas(), withAgentTools: false });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t6-agent" });
  host.emit("agent/created", { agent });

  assert.equal(host.restrictCalls.length, 0);
  assert.ok(host.logs.some((entry) => entry.level === "warn"));
  assert.equal(host.registered.has("consult_tools"), false);

  host.dispose();
});

test("tools 服务缺失：插件不启用", () => {
  const host = createFakeHost({ schemas: schemas(), withToolsService: false, withAgentTools: false });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t7-agent" });
  host.emit("agent/created", { agent });

  assert.equal(host.restrictCalls.length, 0);
  assert.equal(host.registered.size, 0);
  assert.ok(host.logs.some((entry) => entry.level === "warn"));

  host.dispose();
});

test("名单失配：过滤后重试一次成功", () => {
  const host = createFakeHost({
    schemas: schemas(),
    restrictFailure: { message: 'tools.restrict() names unknown global tool "ghost"', times: 1 },
  });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t8-agent" });
  host.emit("agent/created", { agent });

  assert.equal(host.restrictCalls.length, 1);
  assert.deepEqual(host.activeMask(), CORE);

  host.dispose();
});

test("插件卸载：撤销遮罩并注销咨询工具", () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t9-agent" });
  host.emit("agent/created", { agent });

  assert.equal(host.registered.has("consult_tools"), true);
  assert.ok(host.activeMask() !== undefined);

  host.dispose();

  assert.equal(host.activeMask(), undefined);
  assert.equal(host.registered.has("consult_tools"), false);
});
