import assert from "node:assert/strict";
import { test } from "node:test";

import { apply } from "../src/index.ts";
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
  "hash_read",
  "hash_edit",
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
    description: `${name} 工具: 用于 ${name} 场景。`,
    parameters: { properties: { action: { type: "string" } } },
  }));
}

test("服务形状不符: 非对象 tools / 缺 list 的 agents 都按缺服务处理", () => {
  const badTools = createFakeHost({
    schemas: schemas(),
    serviceValues: { tools: "not-a-service" },
  });
  apply(badTools.ctx, {});
  assert.equal(badTools.listenerCount(), 0);
  assert.ok(
    badTools.logs.some((entry) => entry.message.includes("宿主缺少 tools")),
  );

  const badAgents = createFakeHost({
    schemas: schemas(),
    serviceValues: { agents: {} },
  });
  apply(badAgents.ctx, {});
  assert.equal(badAgents.listenerCount(), 0);
  assert.ok(
    badAgents.logs.some((entry) => entry.message.includes("宿主缺少 tools")),
  );
});

test("日志面缺失 / 抛错 / 缺方法都不影响主流程", () => {
  for (const [index, options] of [
    { withLogger: false },
    { loggerThrows: true },
    { loggerPartial: true },
  ].entries()) {
    const host = createFakeHost({ schemas: schemas(), ...options });
    assert.doesNotThrow(() => apply(host.ctx, {}));
    const agent = host.addAgent({ id: `log-${index}` });
    assert.doesNotThrow(() => host.emit("agent/created", { agent }));
    assert.ok(host.activeMask() !== undefined);
    host.dispose();
  }
});

test("agent/created 载荷异常: 缺代理 / id 非字符串 / 缺 ctx 都跳过", () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  host.emit("agent/created", undefined);
  host.emit("agent/created", {});
  host.emit("agent/created", { agent: { id: 1 } });
  host.emit("agent/created", { agent: { id: "no-ctx" } });

  assert.equal(host.restrictCalls.length, 0);
  assert.equal(host.registered.size, 0);
});

test("工具服务缺 schemas: 空可限制名回退不遮, 广播与检索不抛错", async () => {
  const host = createFakeHost({ schemas: schemas() });
  host.tools.schemas = undefined as unknown as typeof host.tools.schemas;
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "no-schemas" });
  host.emit("agent/created", { agent });

  assert.equal(host.restrictCalls.length, 0);
  assert.ok(host.logs.some((entry) => entry.message.includes("无交集")));
  assert.equal(host.registered.has("consult_tools"), true);
  assert.doesNotThrow(() => host.emit("tools/change"));

  const definition = host.registered.get("consult_tools");
  const execute = definition?.execute as (
    args: Record<string, unknown>,
  ) => Promise<{ text: string }>;
  const result = await execute({ query: "任意" });
  assert.ok(result.text.includes("当前没有可咨询的工具（工具面为空）。"));
  host.dispose();
});

test("空交集两种模式: 初始清单全不命中 / denylist 遮光全部", () => {
  const allow = createFakeHost({ schemas: schemas() });
  apply(allow.ctx, { initialTools: ["ghost"] });
  const allowAgent = allow.addAgent({ id: "empty-allow" });
  allow.emit("agent/created", { agent: allowAgent });
  assert.equal(allow.restrictCalls.length, 0);
  assert.ok(allow.logs.some((entry) => entry.message.includes("无交集")));

  const deny = createFakeHost({ schemas: schemas() });
  apply(deny.ctx, { maskMode: "denylist", initialTools: ["*"] });
  const denyAgent = deny.addAgent({ id: "empty-deny" });
  deny.emit("agent/created", { agent: denyAgent });
  assert.equal(deny.restrictCalls.length, 0);
  assert.ok(deny.logs.some((entry) => entry.message.includes("无交集")));
});

test("restrict 其他错误: 回退不遮且只告警一次", async () => {
  const host = createFakeHost({
    schemas: schemas(),
    restrictFailure: { message: "boom", times: 2 },
  });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "restrict-boom" });
  host.emit("agent/created", { agent });
  assert.equal(host.activeMask(), undefined);
  assert.equal(
    host.logs.filter((entry) => entry.message.includes("遮罩安装失败")).length,
    1,
  );

  const definition = host.registered.get("consult_tools");
  const execute = definition?.execute as (
    args: Record<string, unknown>,
  ) => Promise<{ text: string }>;
  await execute({ names: ["rule_add"] });
  assert.equal(
    host.logs.filter((entry) => entry.message.includes("遮罩安装失败")).length,
    1,
    "同一运行时的降级告警只打一次",
  );
  assert.equal(host.activeMask(), undefined);
});

test("restrict 名单失配: 过滤重试再失败时按降级处理", () => {
  const host = createFakeHost({
    schemas: schemas(),
    restrictFailure: {
      message: 'tools.restrict() names unknown global tool "ghost"',
      times: 2,
    },
  });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "restrict-unknown" });
  host.emit("agent/created", { agent });

  assert.equal(host.restrictCalls.length, 0);
  assert.ok(
    host.logs.some((entry) => entry.message.includes("遮罩名单含未知工具")),
  );
});

test("代理作用域缺事件面: 照常注册与遮罩, 但无拦截钩子", () => {
  const host = createFakeHost({ schemas: schemas(), agentEvents: false });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "no-agent-events" });
  host.emit("agent/created", { agent });

  assert.equal(host.activeMask()?.length, 9);
  assert.equal(
    agent.emit("tools/pre-execute", { name: "rule_add" }, () => ({
      kind: "allow",
    })),
    undefined,
  );
});

test("代理作用域缺 register: 咨询工具不注册, 遮罩照常", () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "no-register" });
  assert.ok(agent.ctx.tools !== undefined);
  (agent.ctx.tools as { register?: unknown }).register = undefined;
  host.emit("agent/created", { agent });

  assert.equal(host.registered.size, 0);
  assert.ok(
    host.logs.some((entry) => entry.message.includes("缺少 tools.register")),
  );
  assert.equal(host.activeMask()?.length, 9);
});

test("卸载时 disposer 抛错被吞掉, 遮罩与工具仍被清理", () => {
  const host = createFakeHost({
    schemas: schemas(),
    disposeThrows: true,
    listenerDisposeThrows: true,
  });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "dispose-throws" });
  host.emit("agent/created", { agent });
  assert.equal(host.registered.has("consult_tools"), true);

  assert.doesNotThrow(() => host.dispose());
  assert.equal(host.activeMask(), undefined);
  assert.equal(host.registered.has("consult_tools"), false);
});

test("session/event 非法载荷: 非字符串会话 / 缺事件 / 缺回合号都不抛错", () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, { revealScope: "turn" });
  const agent = host.addAgent({ id: "event-shape" });
  host.emit("agent/created", { agent });

  assert.doesNotThrow(() => {
    host.emit("session/event", { id: 1 }, { type: "turn/start" });
    host.emit("session/event", { id: agent.id }, undefined);
    host.emit("session/event", { id: agent.id }, { type: "turn/start" });
    host.emit("session/event", { id: agent.id }, { type: "turn/end" });
    host.emit(
      "session/event",
      { id: agent.id },
      {
        type: "turn/end",
        data: {},
      },
    );
    host.emit("session/event", { id: agent.id }, { type: "unknown" });
  });
  assert.equal(host.activeMask()?.length, 9);
  host.dispose();
});

test("配置热重载: 复用既有运行时并切换缺省档", async () => {
  const host = createFakeHost({ schemas: schemas() });
  apply(host.ctx, {});
  const agent = host.addAgent({ id: "reload" });
  host.emit("agent/created", { agent });
  await (
    host.registered.get("consult_tools")?.execute as (
      args: Record<string, unknown>,
    ) => Promise<unknown>
  )({ names: ["rule_add"] });
  assert.ok(host.activeMask()?.includes("rule_add"));

  apply(host.ctx, { revealScope: "turn" });
  const definition = host.registered.get("consult_tools");
  const result = (await (
    definition?.execute as (
      args: Record<string, unknown>,
    ) => Promise<{ text: string }>
  )({ names: ["task_status"] })) as { text: string };
  assert.ok(result.text.includes("已揭示（仅本回合有效"), result.text);
  assert.ok(
    (
      await (
        definition?.execute as (
          args: Record<string, unknown>,
        ) => Promise<{ text: string }>
      )({ names: ["rule_add"] })
    ).text.includes("已在可见集"),
    "既有授权在热重载后保留",
  );
  host.dispose();
});
