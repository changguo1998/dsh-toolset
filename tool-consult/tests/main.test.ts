import assert from "node:assert/strict";
import { test } from "node:test";

import { assemble } from "./assemble.ts";
import { resetSurfaceCatalog } from "@dsh-toolset/tool-surface";

/** 每次装配前清空模块级 catalog，避免跨用例串味。 */
function fresh(options: Parameters<typeof assemble>[0] = {}) {
  resetSurfaceCatalog();
  return assemble(options);
}

/** 某代理当前可见的工具名（按名排序）。 */
function visibleNames(host: ReturnType<typeof assemble>["host"], id: string) {
  return (host.tools.schemas({ id }) ?? [])
    .map((schema) => schema.name)
    .sort((a, b) => a.localeCompare(b));
}

test("注册：初始 14 个不 shadow，其余非条件工具按名排序 shadow", () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "register-root" });
  const initial = [
    "ask_user_question",
    "bash",
    "edit",
    "glob",
    "grep",
    "job_kill",
    "job_list",
    "job_output",
    "read",
    "read_image",
    "skill",
    "web_fetch",
    "web_search",
    "write",
  ];
  const shadows = [...(app.host.scoped.get(agent.id)?.keys() ?? [])].sort();
  assert.deepEqual(
    shadows,
    [
      "consult_tools",
      "hash_edit",
      "hash_read",
      "task_decompose",
      "task_status",
      "todo_write",
    ].sort(),
  );
  assert.equal(app.host.registered.has("consult_tools"), false);
  const shadowed = shadows.filter((name) => name !== "consult_tools");
  for (const name of initial) assert.equal(shadowed.includes(name), false);
  const consult = app.consult(agent.id);
  assert.equal(consult.name, "consult_tools");
  assert.equal(
    (consult.parameters as { properties?: Record<string, unknown> }).properties
      ? "scope" in
          (consult.parameters as { properties: Record<string, unknown> })
            .properties
      : false,
    false,
  );
});

test("shadow 定义换位：短说明 + 宽松占位，全文进 catalog", () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "shadow-shape" });
  const shadow = app.host.scoped.get(agent.id)?.get("hash_read");
  assert.ok(shadow);
  assert.ok(shadow.description.includes("tool_consult"));
  assert.deepEqual(shadow.parameters, {
    type: "object",
    additionalProperties: true,
    properties: {},
    description: "完整参数 schema 经 tool_consult 查询",
  });
  assert.ok(
    shadow.description.includes("完整说明与参数 schema 经 tool_consult 查询。"),
  );
  assert.equal(
    app.host.scoped.get(agent.id)?.get("hash_read")?.parameters[
      "additionalProperties"
    ],
    true,
  );
});

test("白名单外条件工具：静态 deny, 模型面 / 索引 / 揭示 / hold 均不可得", async () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "deny-root" });
  assert.deepEqual(app.host.activeDeny(agent.id), [
    "exit_plan_mode",
    "team_task_list",
  ]);
  const visible = visibleNames(app.host, agent.id);
  assert.equal(visible.includes("team_task_list"), false);
  assert.equal(visible.includes("exit_plan_mode"), false);
  assert.equal(
    app.host.scoped.get(agent.id)?.has("team_task_list"),
    false,
    "条件工具不应被 shadow",
  );

  const byName = await app.executeText(
    { names: ["team_task_list"] },
    undefined,
    agent.id,
  );
  assert.ok(byName.includes("未知工具"), byName);
  const byQuery = await app.executeText(
    { query: "Team 任务列表" },
    undefined,
    agent.id,
  );
  assert.equal(byQuery.includes("team_task_list"), false, byQuery);
  assert.equal(app.pinNotes.keys().includes("revealed:team_task_list"), false);
});

test("白名单内条件工具：保持宿主原样, 不 shadow / 不 deny", () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "allow-when" });
  const visible = visibleNames(app.host, agent.id);
  assert.ok(visible.includes("web_search"));
  assert.ok(visible.includes("web_fetch"));
  assert.equal(app.host.scoped.get(agent.id)?.has("web_search"), false);
  assert.equal(app.host.scoped.get(agent.id)?.has("web_fetch"), false);
  assert.equal(app.host.activeDeny(agent.id)?.includes("web_search"), false);
});

test("门禁：未揭示的受管工具被拒，初始与咨询入口放行；揭示后放行", async () => {
  const app = fresh();
  app.apply();
  const first = app.addAgent({ id: "gate-first" });
  const second = app.addAgent({ id: "gate-second" });
  const allow = () => ({ kind: "allow" });

  assert.deepEqual(
    first.emit("tools/pre-execute", { name: "hash_read" }, allow),
    {
      kind: "deny",
      reason:
        "tool hash_read 未在当前会话揭示, 请先经 tool_consult 查询后再调用",
      info: { name: "TOOL_NOT_REVEALED", code: "TOOL_NOT_REVEALED" },
    },
  );
  assert.deepEqual(first.emit("tools/pre-execute", { name: "bash" }, allow), {
    kind: "allow",
  });
  assert.deepEqual(
    first.emit("tools/pre-execute", { name: "consult_tools" }, allow),
    { kind: "allow" },
  );

  const text = await app.executeText(
    { names: ["hash_read"] },
    undefined,
    first.id,
  );
  assert.ok(text.includes("已揭示"), text);
  assert.deepEqual(
    first.emit("tools/pre-execute", { name: "hash_read" }, allow),
    {
      kind: "allow",
    },
  );
  assert.equal(
    (
      second.emit("tools/pre-execute", { name: "hash_read" }, allow) as {
        kind: string;
      }
    ).kind,
    "deny",
    "第二个代理不被第一个代理的揭示影响",
  );
});

test("揭示不改 schemas：前后深相等；每工具 hold 投递全文与 schema", async () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "reveal-stable" });
  const before = app.host.tools.schemas({ id: agent.id });
  assert.ok(before);
  const text = await app.executeText(
    { names: ["hash_read", "task_status"] },
    undefined,
    agent.id,
  );
  assert.ok(text.includes("已揭示"), text);
  const after = app.host.tools.schemas({ id: agent.id });
  assert.deepEqual(after, before, "揭示不得新增 / 删除 / 重排声明");

  assert.deepEqual(app.pinNotes.keys().sort(), [
    "revealed:hash_read",
    "revealed:task_status",
  ]);
  const payload = app.pinNotes.text("revealed:hash_read", agent.id);
  assert.ok(payload);
  assert.ok(payload.includes("按行号锚点读取的完整说明。"));
  assert.ok(payload.includes('"input_schema"'));
  assert.equal(
    app.pinNotes.text("revealed:hash_read", "other-session"),
    undefined,
  );

  const duplicate = await app.executeText(
    { names: ["hash_read"] },
    undefined,
    agent.id,
  );
  assert.ok(duplicate.includes("已在本会话揭示"), duplicate);
});

test("预览不写授权, 也不登记 hold", async () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "preview" });
  const text = await app.executeText(
    { names: ["hash_edit"], reveal: false },
    undefined,
    agent.id,
  );
  assert.ok(text.includes("预览，未揭示"), text);
  assert.deepEqual(app.pinNotes.keys(), []);
  assert.equal(
    (
      agent.emit("tools/pre-execute", { name: "hash_edit" }, () => ({
        kind: "allow",
      })) as { kind: string }
    ).kind,
    "deny",
  );
});

test("tools/change：晚注册条件工具补 deny, 晚注册非条件工具不补 shadow 且放行", () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "change-add" });
  app.host.addDefinition({
    name: "late_when",
    description: "晚注册条件工具。",
    parameters: {},
    execute: () => ({}),
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: () => [],
    },
    when: () => false,
  });
  assert.equal(app.host.activeDeny(agent.id)?.includes("late_when"), true);
  assert.equal(
    (app.host.tools.schemas({ id: agent.id }) ?? []).some(
      (schema) => schema.name === "late_when",
    ),
    false,
  );
  assert.equal(app.host.scoped.get(agent.id)?.has("late_when"), false);

  app.host.addSchema({ name: "late_plain", description: "晚注册普通工具。" });
  assert.equal(app.host.scoped.get(agent.id)?.has("late_plain"), false);
  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "late_plain" }, () => ({
      kind: "allow",
    })),
    { kind: "allow" },
  );
});

test("self-check 失败：整体不接管, 不注册 / 不 deny / 不挂监听, 只告警一次", () => {
  const app = fresh({ serviceValues: { toolSurface: undefined } });
  app.apply();
  const agent = app.addAgent({ id: "no-surface" });
  assert.equal(app.host.restrictCalls.length, 0);
  assert.equal(app.host.scoped.get(agent.id)?.size ?? 0, 0);
  assert.equal(app.host.listenerCount("tools/change"), 0);
  const warnings = app.host.logs.filter(
    (entry) =>
      entry.level === "warn" && entry.message.includes("catalog 自检失败"),
  );
  assert.equal(warnings.length, 1, JSON.stringify(app.host.logs));
});

test("restrict 失败：本代理不接管, 撤 deny 且不 shadow / 不注册咨询工具", () => {
  const app = fresh({
    restrictFailure: { message: "deny boom", times: 1 },
  });
  app.apply();
  const agent = app.addAgent({ id: "deny-fail" });
  assert.equal(app.host.activeDeny(agent.id), undefined);
  assert.equal(
    app.host.scoped.get(agent.id)?.has("consult_tools") ?? false,
    false,
  );
  assert.equal(app.host.scoped.get(agent.id)?.has("hash_read") ?? false, false);
  assert.ok(
    app.host.logs.some((entry) => entry.message.includes("条件工具隐藏失败")),
  );
});

test("deny 残留：本代理不接管, 撤 deny 且零注册", () => {
  const app = fresh({ residualNames: ["team_task_list"] });
  app.apply();
  const agent = app.addAgent({ id: "residual" });
  assert.equal(app.host.activeDeny(agent.id), undefined);
  assert.equal(app.host.scoped.get(agent.id)?.size ?? 0, 0);
  assert.ok(
    app.host.logs.some((entry) => entry.message.includes("隐藏后仍在工具面")),
  );
});

test("子代理默认不接管；applyTo=all 时接管", () => {
  const roots = fresh();
  roots.apply();
  const child = roots.addAgent({
    id: "subagent",
    header: { origin: "subagent" },
  });
  assert.equal(roots.host.scoped.get(child.id)?.size ?? 0, 0);
  assert.equal(roots.host.restrictCalls.length, 0);

  const all = fresh();
  all.apply({ applyTo: "all" });
  const childAll = all.addAgent({
    id: "subagent-all",
    header: { origin: "subagent" },
  });
  assert.ok((all.host.scoped.get(childAll.id)?.size ?? 0) > 0);
});

test("热重载：保留授权, 新白名单即时生效, hold 重新登记", async () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "hot-reload" });
  await app.executeText({ names: ["hash_read"] }, undefined, agent.id);
  assert.ok(app.pinNotes.keys().includes("revealed:hash_read"));

  app.apply({
    allowedWhenTools: ["web_search", "web_fetch", "team_task_list"],
  });
  assert.equal(
    app.host.activeDeny(agent.id)?.includes("team_task_list"),
    false,
  );
  assert.ok(
    (app.host.tools.schemas({ id: agent.id }) ?? []).some(
      (schema) => schema.name === "team_task_list",
    ),
  );
  assert.ok(app.pinNotes.keys().includes("revealed:hash_read"));
  const text = await app.executeText(
    { names: ["hash_read"] },
    undefined,
    agent.id,
  );
  assert.ok(text.includes("已在本会话揭示"), text);
});

test("pinNotes 缺席：揭示仍写授权, 只告警一次", async () => {
  const app = fresh({ serviceValues: { pinNotes: undefined } });
  app.apply();
  const agent = app.addAgent({ id: "no-pin" });
  const text = await app.executeText(
    { names: ["hash_read", "task_status"] },
    undefined,
    agent.id,
  );
  assert.ok(text.includes("已揭示"), text);
  assert.equal(
    (
      agent.emit("tools/pre-execute", { name: "hash_read" }, () => ({
        kind: "allow",
      })) as { kind: string }
    ).kind,
    "allow",
  );
  assert.equal(
    app.host.logs.filter((entry) => entry.message.includes("pinNotes 不可用"))
      .length,
    2,
    "apply 一次 + 首次揭示一次",
  );
});
