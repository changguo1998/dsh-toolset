import assert from "node:assert/strict";
import { test } from "node:test";

import { assemble } from "../assemble.ts";

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

test("装配: 既有代理热挂载, 9 核心遮罩与 consult_tools 注册", (t) => {
  const app = assemble();
  const agent = app.addAgent({ id: "int-hot", emitCreated: false });
  assert.deepEqual(app.services.names(), ["tools", "agents"]);
  assert.equal(app.services.has("tools"), true);
  assert.equal(
    typeof (app.services.get("agents") as { list?: unknown } | undefined)?.list,
    "function",
  );

  app.apply({});
  t.after(() => app.dispose());

  assert.deepEqual(app.tools.names(), ["consult_tools"]);
  assert.deepEqual(app.host.activeMask(), CORE);
  assert.equal(app.events.listenerCount(), 5, "应有 5 条全局订阅");
  assert.equal(app.events.listenerCount("agent/created"), 1);
  assert.equal(app.events.listenerCount("agent/disposed"), 1);
  assert.equal(app.events.listenerCount("tools/change"), 1);
  assert.equal(app.events.listenerCount("tools/result"), 1);
  assert.equal(app.events.listenerCount("session/event"), 1);
  assert.equal(agent.session.id, "int-hot");
});

test("execute 与 output.render: 用途查询返回 canonical 文本并可投影", async (t) => {
  const app = assemble();
  app.apply({});
  t.after(() => app.dispose());
  app.addAgent({ id: "int-query" });

  const text = await app.executeText({ query: "跨会话发消息" });
  assert.match(text, /^已揭示（本会话内持续可见，下一次请求起可调用）：/);
  assert.ok(text.includes("- session_channel："));
  assert.ok(text.includes("- channel_delegate："));
  assert.ok(text.includes("session 档已揭示 2 项"), text);
  assert.ok((app.host.activeMask() ?? []).includes("session_channel"));

  const value = { text };
  assert.deepEqual(app.render(value), [{ type: "text", text }]);
  assert.deepEqual(app.render(undefined), [
    { type: "text", text: "undefined" },
  ]);
  assert.deepEqual(app.render({ noText: true }), [
    { type: "text", text: "[object Object]" },
  ]);
  assert.deepEqual(app.render(value, { query: "x" }), [{ type: "text", text }]);
});

test("按名咨询: 预览 / 未知 / 已在可见集 / 入口自身都不揭示", async (t) => {
  const app = assemble();
  app.apply({});
  t.after(() => app.dispose());
  app.addAgent({ id: "int-names" });

  const before = app.host.restrictCalls.length;
  const text = await app.executeText({
    names: [
      "channel_delegate",
      "ghost",
      "read",
      "task_status",
      "consult_tools",
    ],
    reveal: false,
  });
  assert.ok(
    text.includes(
      "- channel_delegate：channel_delegate 工具: 用于 channel_delegate 场景。（预览，未揭示）",
    ),
    text,
  );
  assert.ok(text.includes("- ghost：未知工具（不在当前工具面里）"), text);
  assert.ok(
    text.includes(
      "- read：read 工具: 用于 read 场景。（已在可见集，直接调用即可）",
    ),
    text,
  );
  assert.ok(
    text.includes(
      "- task_status：task_status 工具: 用于 task_status 场景。（预览，未揭示）",
    ),
    text,
  );
  assert.ok(text.includes("- consult_tools（已在可见集，直接调用即可）"), text);
  assert.equal(app.host.restrictCalls.length, before, "预览不改变遮罩");
});

test("pre-execute: 未揭示 deny, 核心与揭示后 allow", async (t) => {
  const app = assemble();
  app.apply({});
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-deny" });

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

  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "bash" }, () => ({
      kind: "allow",
    })),
    { kind: "allow" },
  );
  // 缺工具名 / 缺 next 都按放行处理。
  assert.deepEqual(agent.emit("tools/pre-execute", {}), { kind: "allow" });
  assert.deepEqual(agent.emit("tools/pre-execute", { name: "bash" }), {
    kind: "allow",
  });

  await app.executeText({ names: ["rule_add"] });
  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "rule_add" }, () => ({
      kind: "allow",
    })),
    { kind: "allow" },
  );
});

test("turn 档: pin 跨回合保留, 未钉住项按容量收敛", async (t) => {
  const app = assemble();
  app.apply({ revealScope: "turn", maxRevealed: 1, maxPinned: 3 });
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-turn" });

  const pinned = await app.executeText({ names: ["rule_add"], pin: true });
  assert.match(pinned, /^已揭示（仅本回合有效，下一次请求起可调用）：/);
  assert.ok(pinned.includes("[已钉住]"), pinned);
  assert.ok(pinned.includes("turn 档已揭示 1 项（钉住 1 / 3）"), pinned);

  await app.executeText({ names: ["rule_update"] });
  app.events.emit(
    "session/event",
    { id: agent.id },
    { type: "turn/start", data: { turn: 1 } },
  );
  app.events.emit(
    "session/event",
    { id: agent.id },
    { type: "turn/end", data: { turn: 1 } },
  );

  const mask = app.host.activeMask() ?? [];
  assert.ok(mask.includes("rule_add"), "钉住项不参与收敛");
  assert.ok(!mask.includes("rule_update"), "未钉住项按容量收敛");
});

test("turn 档: pin 名额满 / session 档 pin 被忽略的文案", async (t) => {
  const full = assemble();
  full.apply({ revealScope: "turn", maxPinned: 0 });
  t.after(() => full.dispose());
  full.addAgent({ id: "int-pin-full" });
  const text = await full.executeText({ names: ["rule_add"], pin: true });
  assert.ok(text.includes("[钉住名额已满，按普通揭示处理]"), text);

  const session = assemble();
  session.apply({});
  t.after(() => session.dispose());
  session.addAgent({ id: "int-pin-session" });
  const ignored = await session.executeText({ names: ["rule_add"], pin: true });
  assert.ok(ignored.includes("[pin 仅 turn 档生效，本次忽略]"), ignored);
});

test("tools/result: 刷新 LRU, 非法载荷安全忽略", async (t) => {
  const app = assemble();
  app.apply({ revealScope: "turn", maxRevealed: 1 });
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-lru" });

  await app.executeText({ names: ["rule_add"] });
  await app.executeText({ names: ["rule_update"] });
  app.events.emit(
    "session/event",
    { id: agent.id },
    { type: "turn/start", data: { turn: 1 } },
  );

  // 非法载荷: 无代理 / 代理未知 / 工具名非字符串。
  app.events.emit("tools/result", { name: "rule_add" });
  app.events.emit("tools/result", { agent: { id: "ghost" }, name: "rule_add" });
  app.events.emit("tools/result", { agent, name: 42 });
  // 合法使用: rule_add 的最近使用回合刷新到 1, 获得宽限。
  app.events.emit("tools/result", { agent, name: "rule_add" });

  app.events.emit(
    "session/event",
    { id: agent.id },
    { type: "turn/end", data: { turn: 1 } },
  );
  const mask = app.host.activeMask() ?? [];
  assert.ok(mask.includes("rule_add"), "最近使用的项应保留");
  assert.ok(!mask.includes("rule_update"), "闲置项应被收回");
});

test("tools/change: 只刷新检索索引, 新工具可被检索并揭示", async (t) => {
  const app = assemble();
  app.apply({});
  t.after(() => app.dispose());
  app.addAgent({ id: "int-refresh" });

  const before = await app.executeText({ query: "量子纠缠", reveal: false });
  assert.ok(before.includes("没有匹配的工具。可用的工具分组："), before);

  app.host.addSchema({
    name: "quantum_tool",
    description: "量子纠缠分析工具。",
    parameters: { properties: { action: { type: "string" } } },
  });
  const calls = app.host.restrictCalls.length;
  app.events.emit("tools/change");
  assert.equal(app.host.restrictCalls.length, calls, "广播不得重设遮罩");

  const after = await app.executeText({ query: "量子纠缠", reveal: false });
  assert.ok(
    after.includes("- quantum_tool：量子纠缠分析工具。（预览，未揭示）"),
    after,
  );

  await app.executeText({ names: ["quantum_tool"] });
  assert.ok((app.host.activeMask() ?? []).includes("quantum_tool"));
});

test("denylist: 只遮 initialTools, 揭示可见项为空操作, 揭示被挡项收缩遮罩", async (t) => {
  const app = assemble();
  app.apply({ maskMode: "denylist", initialTools: ["bash", "read"] });
  t.after(() => app.dispose());
  app.addAgent({ id: "int-denylist" });

  const mask = app.host.activeMask() ?? [];
  assert.ok(!mask.includes("bash"), "清单内工具应被挡住");
  assert.ok(!mask.includes("read"));
  assert.ok(mask.includes("write"), "清单外工具应可见");
  assert.ok(mask.includes("rule_add"));

  // 已在可见集: 揭示是空操作, 不重挂遮罩。
  const calls = app.host.restrictCalls.length;
  const visible = await app.executeText({ names: ["task_status"] });
  assert.ok(visible.includes("已在可见集"), visible);
  assert.equal(app.host.restrictCalls.length, calls, "揭示已可见项不重挂遮罩");
  assert.deepEqual(app.host.activeMask(), mask, "名单不变");

  // 被挡项: 揭示后该名进入允许集, 遮罩收缩并重挂一次。
  const revealed = await app.executeText({ names: ["bash"] });
  assert.ok(revealed.includes("已揭示"), revealed);
  assert.equal(
    app.host.restrictCalls.length,
    calls + 1,
    "揭示被挡项会重挂遮罩",
  );
  const narrowed = app.host.activeMask() ?? [];
  assert.ok(narrowed.includes("bash"), "被挡项揭示后应可见");
  assert.ok(!narrowed.includes("read"), "未揭示的被挡项仍被挡住");
  assert.equal(narrowed.length, mask.length + 1);
});

test("maskMode=off: 零遮罩, 咨询工具仍可揭示", async (t) => {
  const app = assemble();
  app.apply({ maskMode: "off" });
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-off" });

  assert.equal(app.host.restrictCalls.length, 0);
  assert.equal(app.host.activeMask(), undefined);
  assert.deepEqual(app.tools.names(), ["consult_tools"]);

  const text = await app.executeText({ names: ["rule_add"] });
  assert.ok(text.includes("已揭示"), text);
  assert.equal(app.host.restrictCalls.length, 0, "off 模式不装遮罩");
  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "rule_add" }, () => ({
      kind: "allow",
    })),
    { kind: "allow" },
  );
});

test("applyTo: all 管子代理, roots 跳过子代理", (t) => {
  const all = assemble();
  all.apply({ applyTo: "all" });
  t.after(() => all.dispose());
  all.addAgent({ id: "int-child-all", header: { delegationDepth: 1 } });
  assert.deepEqual(all.tools.names(), ["consult_tools"]);
  assert.deepEqual(all.host.activeMask(), CORE);

  const roots = assemble();
  roots.apply({});
  t.after(() => roots.dispose());
  roots.addAgent({ id: "int-child-roots", header: { delegationDepth: 1 } });
  assert.deepEqual(roots.tools.names(), []);
  assert.equal(roots.host.restrictCalls.length, 0);

  roots.addAgent({ id: "int-child-origin", header: { origin: "subagent" } });
  assert.deepEqual(roots.tools.names(), []);
});

test("服务缺失: 不注册、不遮罩并告警", (t) => {
  const noTools = assemble({ toolsService: false, withAgentTools: false });
  noTools.apply({});
  assert.deepEqual(noTools.tools.names(), []);
  assert.equal(noTools.events.listenerCount(), 0);
  assert.ok(
    noTools
      .logs()
      .some((line) => line.includes("宿主缺少 tools / agents 服务")),
  );

  const noAgents = assemble({ agentsService: false });
  noAgents.apply({});
  assert.deepEqual(noAgents.tools.names(), []);
  assert.ok(
    noAgents
      .logs()
      .some((line) => line.includes("宿主缺少 tools / agents 服务")),
  );
});

test("agent/disposed: 撤遮罩与注销工具, 同 id 可重新挂载", (t) => {
  const app = assemble();
  app.apply({});
  t.after(() => app.dispose());
  const agent = app.addAgent({ id: "int-dispose" });
  assert.deepEqual(app.host.activeMask(), CORE);

  // 非法载荷安全忽略。
  app.events.emit("agent/disposed", {});
  app.events.emit("agent/disposed", { agent: { id: 1 } });
  app.events.emit("agent/disposed", { agent: { id: "ghost" } });
  assert.deepEqual(app.host.activeMask(), CORE);

  app.events.emit("agent/disposed", { agent });
  assert.equal(app.host.activeMask(), undefined);
  assert.deepEqual(app.tools.names(), []);

  app.addAgent({ id: "int-dispose" });
  assert.deepEqual(app.tools.names(), ["consult_tools"]);
  assert.deepEqual(app.host.activeMask(), CORE);
});

test("插件卸载: 多代理的遮罩与工具全部清理", (t) => {
  const app = assemble();
  app.apply({});
  app.addAgent({ id: "int-unload-a" });
  app.addAgent({ id: "int-unload-b" });
  assert.deepEqual(app.tools.names(), ["consult_tools"]);

  app.host.dispose();
  assert.equal(app.host.activeMask(), undefined);
  assert.deepEqual(app.tools.names(), []);
});

test("咨询工具注册失败: 重名只告警, 遮罩照常", (t) => {
  const duplicate = assemble({
    registerFailure: {
      message: 'tool "consult_tools" is already registered in this scope',
      times: 1,
    },
  });
  duplicate.apply({});
  t.after(() => duplicate.dispose());
  duplicate.addAgent({ id: "int-dup" });
  assert.deepEqual(duplicate.tools.names(), []);
  assert.ok(
    duplicate.logs().some((line) => line.includes("咨询工具名已被占用")),
  );
  assert.deepEqual(duplicate.host.activeMask(), CORE);

  const other = assemble({
    registerFailure: { message: "boom", times: 1 },
  });
  other.apply({});
  t.after(() => other.dispose());
  other.addAgent({ id: "int-reg-other" });
  assert.deepEqual(other.tools.names(), []);
  assert.ok(other.logs().some((line) => line.includes("咨询工具注册失败")));
  assert.deepEqual(other.host.activeMask(), CORE);
});

test("enabled=false: 零注册零订阅", (t) => {
  const app = assemble();
  app.apply({ enabled: false });
  t.after(() => app.dispose());
  app.addAgent({ id: "int-disabled" });
  assert.deepEqual(app.tools.names(), []);
  assert.equal(app.events.listenerCount(), 0);
  assert.equal(app.host.restrictCalls.length, 0);
});

test("空工具面: 回退不遮, 检索给出空目录文案", async (t) => {
  const app = assemble({ schemas: [] });
  app.apply({});
  t.after(() => app.dispose());
  app.addAgent({ id: "int-empty" });

  assert.equal(app.host.restrictCalls.length, 0);
  assert.ok(
    app.logs().some((line) => line.includes("无交集")),
    "空交集应告警",
  );
  const text = await app.executeText({ query: "任意" });
  assert.ok(text.includes("当前没有可咨询的工具（工具面为空）。"), text);
  assert.ok(text.includes("session 档已揭示 0 项"), text);
});

test("回读校验: 缺项告警一次, 漂移恢复后可再次告警", (t) => {
  const app = assemble();
  app.apply({});
  t.after(() => app.dispose());
  app.addAgent({ id: "int-drift" });
  const drift = (): number =>
    app.logs().filter((line) => line.includes("未按预期生效")).length;

  app.host.setHiddenVisible(["bash"]);
  app.events.emit("tools/change");
  assert.equal(drift(), 1);
  assert.ok(app.logs().some((line) => line.includes("该可见却缺：bash")));
  app.events.emit("tools/change");
  assert.equal(drift(), 1, "同一段漂移不重复刷日志");

  app.host.setHiddenVisible([]);
  app.events.emit("tools/change");
  assert.equal(drift(), 1, "恢复后不新增告警");

  app.host.setHiddenVisible(["read"]);
  app.events.emit("tools/change");
  assert.equal(drift(), 2, "恢复后再次漂移应重新告警");

  const silent = assemble({ schemaViewUndefined: true });
  silent.apply({});
  t.after(() => silent.dispose());
  silent.addAgent({ id: "int-drift-silent" });
  assert.equal(
    silent.logs().filter((line) => line.includes("未按预期生效")).length,
    0,
    "宿主不提供作用域视图时无从校验, 不告警",
  );
});
