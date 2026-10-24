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
  return definition.execute as (
    args: Record<string, unknown>,
  ) => Promise<{ text: string }>;
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
  assert.equal(
    host.restrictCalls[0]?.disposed,
    true,
    "旧遮罩应被撤销（替换式）",
  );
  const mask = host.activeMask() ?? [];
  assert.ok(mask.includes("session_channel"));
  assert.ok(mask.length > CORE.length);

  const deny = agent.emit("tools/pre-execute", { name: "rule_add" }, () => ({
    kind: "allow",
  }));
  assert.deepEqual(deny, {
    kind: "deny",
    reason:
      '工具 "rule_add" 当前不可见（被 tool-consult 管理）。' +
      '调用 consult_tools（names: ["rule_add"]）揭示后即可调用；' +
      "也可以 query 描述用途来检索。",
  });

  const allow = agent.emit("tools/pre-execute", { name: "bash" }, () => ({
    kind: "allow",
  }));
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

  host.emit(
    "session/event",
    { id: agent.id },
    { type: "turn/start", data: { turn: 1 } },
  );
  await execute({ names: ["rule_update"] });
  host.emit(
    "session/event",
    { id: agent.id },
    { type: "turn/end", data: { turn: 1 } },
  );

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
  host.emit(
    "session/event",
    { id: agent.id },
    { type: "turn/start", data: { turn: 1 } },
  );
  host.emit(
    "session/event",
    { id: agent.id },
    { type: "turn/end", data: { turn: 1 } },
  );

  const mask = host.activeMask() ?? [];
  assert.ok(mask.includes("rule_add"), "钉住项不参与收敛");
  assert.ok(!mask.includes("rule_update"));

  host.dispose();
});

test("applyTo=roots：子代理不遮、不注册咨询工具", () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  const child = host.addAgent({
    id: "t5-child",
    header: { origin: "subagent" },
  });
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
  const host = createFakeHost({
    schemas: schemas(),
    withToolsService: false,
    withAgentTools: false,
  });
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
    restrictFailure: {
      message: 'tools.restrict() names unknown global tool "ghost"',
      times: 1,
    },
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

test("restrict 同步广播 tools/change：不自激，只应用一条遮罩", () => {
  // 真实宿主：ScopedLayers 每次变化都同步 emit("tools/change")，
  // 其中就包含 restrict() 自身。旧实现会据此再 applyMask，形成死循环。
  const host = createFakeHost({ schemas: schemas(), emitOnRestrict: true });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t10-agent" });
  host.emit("agent/created", { agent });

  assert.equal(host.restrictCalls.length, 1, "只应施加一条遮罩");
  assert.deepEqual(host.activeMask(), CORE);
  assert.equal(
    host.logs.some((entry) => entry.message.includes("未按预期生效")),
    false,
    "遮罩生效时不应告警",
  );

  host.dispose();
});

test("tools/change 广播只复核：不重设遮罩", () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t11-agent" });
  host.emit("agent/created", { agent });
  const before = host.restrictCalls.length;

  host.emit("tools/change");
  host.emit("tools/change");

  assert.equal(host.restrictCalls.length, before, "广播不应触发 restrict");
  assert.deepEqual(host.activeMask(), CORE);

  host.dispose();
});

test("遮罩未生效：只回读告警一次，不重设", () => {
  const host = createFakeHost({ schemas: schemas(), ignoreRestrictions: true });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t12-agent" });
  host.emit("agent/created", { agent });

  const drift = host.logs.filter((entry) =>
    entry.message.includes("未按预期生效"),
  );
  assert.equal(drift.length, 1, "首次回读即告警一次");
  assert.equal(host.restrictCalls.length, 1, "告警后不得重设遮罩");

  host.emit("tools/change");
  assert.equal(
    host.logs.filter((entry) => entry.message.includes("未按预期生效")).length,
    1,
    "同一段漂移不重复刷日志",
  );
  assert.equal(host.restrictCalls.length, 1);

  host.dispose();
});

test("预览模式：命中项未全可见时不打「都已在可见集中」抬头", async () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t13-agent" });
  host.emit("agent/created", { agent });
  const execute = consultOf(host);

  // "跨会话" 只命中未揭示工具（session_channel / channel_delegate）。
  const preview = await execute({ query: "跨会话", reveal: false });
  assert.equal(preview.text.includes("都已在可见集中"), false);
  assert.ok(preview.text.includes("（预览，未揭示）"));
  assert.equal(host.restrictCalls.length, 1, "预览不应揭示");

  // 只命中已可见的工具时才打该抬头。
  const visibleOnly = await execute({ query: "bash", reveal: false, limit: 1 });
  assert.ok(visibleOnly.text.startsWith("命中的工具都已在可见集中"));

  host.dispose();
});

test("turn 档配额不写成上限：文案明说不设新增上限", async () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, { revealScope: "turn" });
  const agent = host.addAgent({ id: "t14-agent" });
  host.emit("agent/created", { agent });
  const execute = consultOf(host);

  const result = await execute({ names: ["task_decompose"] });
  assert.ok(result.text.includes("turn 档不设新增上限"));
  assert.equal(result.text.includes("turn 档 1 / 12"), false);

  host.dispose();
});

test("按名咨询 consult_tools 自身：报「已在可见集」而不是未知工具", async () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "t15-agent" });
  host.emit("agent/created", { agent });
  const execute = consultOf(host);

  const result = await execute({ names: ["consult_tools"] });
  assert.equal(result.text.includes("未知工具"), false);
  assert.ok(result.text.includes("consult_tools"));
  assert.ok(result.text.includes("已在可见集"));

  host.dispose();
});
