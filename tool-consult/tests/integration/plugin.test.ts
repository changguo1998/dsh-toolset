import assert from "node:assert/strict";
import { test } from "node:test";

import { resetSurfaceCatalog } from "@dsh-toolset/tool-surface";
import { assemble } from "../assemble.ts";

function fresh(options: Parameters<typeof assemble>[0] = {}) {
  resetSurfaceCatalog();
  return assemble(options);
}

function visible(host: ReturnType<typeof assemble>["host"], id: string) {
  return (host.tools.schemas({ id }) ?? []).map((schema) => schema.name);
}

test("装配: 既有代理热挂载, 初始 / shadow / deny / consult 一次到位", (t) => {
  const app = fresh();
  const agent = app.addAgent({ id: "int-hot", emitCreated: false });
  assert.deepEqual(app.services.names(), [
    "tools",
    "agents",
    "toolSurface",
    "pinNotes",
  ]);
  app.apply();
  t.after(() => app.dispose());

  assert.equal(app.events.listenerCount(), 3);
  assert.equal(app.events.listenerCount("agent/created"), 1);
  assert.equal(app.events.listenerCount("agent/disposed"), 1);
  assert.equal(app.events.listenerCount("tools/change"), 1);
  assert.deepEqual(app.host.activeDeny(agent.id), [
    "exit_plan_mode",
    "team_task_list",
  ]);
  assert.equal(app.host.scoped.get(agent.id)?.has("consult_tools"), true);
  assert.equal(app.host.scoped.get(agent.id)?.has("hash_read"), true);
  assert.equal(visible(app.host, agent.id).includes("team_task_list"), false);
});

test("咨询流程: 用途查询揭示, output.render 投影稳定", async (t) => {
  const app = fresh();
  app.apply();
  t.after(() => app.dispose());
  app.addAgent({ id: "int-query" });

  const text = await app.executeText({ query: "查看任务状态" });
  assert.match(text, /^已揭示（本会话内有效/);
  assert.ok(text.includes("- task_status：查看任务状态的完整说明。"), text);
  assert.match(text, /本会话已揭示 \d+ 项/);
  assert.deepEqual(app.render({ text }), [{ type: "text", text }]);
  assert.deepEqual(app.render(undefined), [
    { type: "text", text: "undefined" },
  ]);
});

test("按名: 初始 / 预览 / 未知 / 入口自身都不写授权", async (t) => {
  const app = fresh();
  app.apply();
  t.after(() => app.dispose());
  app.addAgent({ id: "int-names" });
  const before = app.host.restrictCalls.length;
  const text = await app.executeText({
    names: ["hash_edit", "ghost", "read", "consult_tools"],
    reveal: false,
  });
  assert.ok(
    text.includes("- hash_edit：按行号锚点改写的完整说明。（预览，未揭示）"),
  );
  assert.ok(text.includes("- ghost：未知工具（不在当前工具面里）"));
  assert.ok(
    text.includes(
      "- read：读取文本文件的完整说明。（已在初始工具面，直接调用即可）",
    ),
  );
  assert.ok(text.includes("- consult_tools（查询入口，直接调用即可）"));
  assert.equal(app.host.restrictCalls.length, before);
  assert.deepEqual(app.pinNotes.keys(), []);
});

test("pre-execute: 未揭示 deny / 初始与咨询入口 allow / 揭示后 allow", async (t) => {
  const app = fresh();
  app.apply();
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-deny" });
  const allow = () => ({ kind: "allow" });

  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "hash_read" }, allow),
    {
      kind: "deny",
      reason:
        "tool hash_read 未在当前会话揭示, 请先经 tool_consult 查询后再调用",
      info: { name: "TOOL_NOT_REVEALED", code: "TOOL_NOT_REVEALED" },
    },
  );
  assert.deepEqual(agent.emit("tools/pre-execute", { name: "read" }, allow), {
    kind: "allow",
  });
  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "consult_tools" }, allow),
    { kind: "allow" },
  );
  // 缺工具名 / 缺 next 都按放行处理。
  assert.deepEqual(agent.emit("tools/pre-execute", {}), { kind: "allow" });
  assert.deepEqual(agent.emit("tools/pre-execute", { name: "read" }), {
    kind: "allow",
  });

  await app.executeText({ names: ["hash_read"] }, undefined, agent.id);
  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "hash_read" }, allow),
    {
      kind: "allow",
    },
  );
});

test("揭示前后 schemas 深相等, 且每工具 hold 只投自己", async (t) => {
  const app = fresh();
  app.apply();
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-stable" });
  const before = app.host.tools.schemas({ id: agent.id });
  await app.executeText(
    { names: ["hash_read", "task_decompose"] },
    undefined,
    agent.id,
  );
  assert.deepEqual(app.host.tools.schemas({ id: agent.id }), before);
  assert.deepEqual(app.pinNotes.keys().sort(), [
    "revealed:hash_read",
    "revealed:task_decompose",
  ]);
  const payload = app.pinNotes.text("revealed:hash_read", agent.id);
  assert.ok(payload);
  assert.match(payload, /按行号锚点读取的完整说明/);
  assert.match(payload, /"input_schema"/);
  assert.equal(
    app.pinNotes.text("revealed:hash_read", "another-session"),
    undefined,
  );
});

test("条件工具白名单: 缺省隐藏; 加名后可见并保留 when; 删名后重新隐藏", (t) => {
  const app = fresh();
  app.apply();
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-when" });
  assert.equal(visible(app.host, agent.id).includes("team_task_list"), false);

  app.apply({
    allowedWhenTools: ["web_search", "web_fetch", "team_task_list"],
  });
  assert.equal(visible(app.host, agent.id).includes("team_task_list"), true);
  assert.equal(
    app.host.activeDeny(agent.id)?.includes("team_task_list"),
    false,
  );

  app.apply({ allowedWhenTools: ["web_search", "web_fetch"] });
  assert.equal(visible(app.host, agent.id).includes("team_task_list"), false);
  assert.equal(app.host.activeDeny(agent.id)?.includes("team_task_list"), true);
});

test("tools/change: 晚注册普通工具进入索引且不补 shadow; 条件工具补 deny", async (t) => {
  const app = fresh();
  app.apply();
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-change" });

  app.host.addSchema({
    name: "quantum_tool",
    description: "量子纠缠分析工具。",
  });
  assert.equal(app.host.scoped.get(agent.id)?.has("quantum_tool"), false);
  const text = await app.executeText(
    { query: "量子纠缠", reveal: false },
    undefined,
    agent.id,
  );
  assert.ok(text.includes("- quantum_tool：量子纠缠分析工具。"), text);
  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "quantum_tool" }, () => ({
      kind: "allow",
    })),
    { kind: "allow" },
    "未纳管的晚注册工具默认放行",
  );

  app.host.addDefinition({
    name: "late_when_int",
    description: "晚注册条件工具。",
    parameters: {},
    execute: () => ({}),
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: () => [],
    },
    when: () => false,
  });
  assert.equal(app.host.activeDeny(agent.id)?.includes("late_when_int"), true);
  assert.equal(visible(app.host, agent.id).includes("late_when_int"), false);
  assert.equal(app.host.scoped.get(agent.id)?.has("late_when_int"), false);
  const denied = await app.executeText(
    { names: ["late_when_int"] },
    undefined,
    agent.id,
  );
  assert.ok(denied.includes("未知工具"), denied);
});

test("自检失败 / restrict 失败 / 残留: 零注册并回退宿主默认", (t) => {
  for (const options of [
    { serviceValues: { toolSurface: undefined } },
    { restrictFailure: { message: "boom", times: 1 } },
    { residualNames: ["team_task_list"] },
  ] as const) {
    const app = fresh(options);
    app.apply();
    t.after(() => app.dispose());
    const agent = app.addAgent({
      id: `int-fail-${Math.random().toString(36).slice(2)}`,
    });
    assert.equal(app.host.scoped.get(agent.id)?.size ?? 0, 0);
    assert.equal(app.host.activeDeny(agent.id), undefined);
    assert.ok(app.host.logs.some((entry) => entry.level === "warn"));
  }
});

test("工具服务缺 schemas: 自检失败, 不接管", (t) => {
  const app = fresh();
  app.host.tools.schemas =
    undefined as unknown as typeof app.host.tools.schemas;
  app.apply();
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-no-schemas" });
  assert.equal(app.host.scoped.get(agent.id)?.size ?? 0, 0);
  assert.ok(
    app.host.logs.some((entry) =>
      entry.message.includes("tools.schemas 不可用"),
    ),
  );
});

test("热重载: 保留授权与新白名单即时生效", async (t) => {
  const app = fresh();
  app.apply();
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-reload" });
  await app.executeText({ names: ["hash_read"] }, undefined, agent.id);

  app.apply({
    allowedWhenTools: ["web_search", "web_fetch", "team_task_list"],
  });
  assert.equal(visible(app.host, agent.id).includes("team_task_list"), true);
  assert.ok(app.pinNotes.keys().includes("revealed:hash_read"));
  const text = await app.executeText(
    { names: ["hash_read"] },
    undefined,
    agent.id,
  );
  assert.ok(text.includes("已在本会话揭示"), text);
});
