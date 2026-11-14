import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isWrappedDefinition,
  resetSurfaceCatalog,
  wrapToolDefinition,
} from "@dsh-toolset/tool-surface";
import { assemble, STANDARD_DEFINITIONS } from "./assemble.ts";

function fresh(options: Parameters<typeof assemble>[0] = {}) {
  resetSurfaceCatalog();
  return assemble(options);
}

test("shadow 注册顺序：非初始工具按名排序，consult_tools 最后", () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "shadow-order" });
  const keys = [...(app.host.scoped.get(agent.id)?.keys() ?? [])];
  assert.deepEqual(keys, [
    "hash_edit",
    "hash_read",
    "task_decompose",
    "task_status",
    "todo_write",
    "consult_tools",
  ]);
});

test("agent/disposed 撤销 shadow；插件卸载撤销全部", () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "shadow-dispose" });
  assert.ok((app.host.scoped.get(agent.id)?.size ?? 0) > 0);
  app.host.emit("agent/disposed", { agent });
  assert.equal(app.host.scoped.get(agent.id)?.size ?? 0, 0);

  const other = app.addAgent({ id: "shadow-plugin-dispose" });
  app.dispose();
  assert.equal(app.host.scoped.get(other.id)?.size ?? 0, 0);
});

test("shadow 注册失败仍纳管：未揭示拒绝，揭示后放行", async () => {
  const app = fresh({ registerFailure: { message: "shadow boom", times: 1 } });
  app.apply();
  const agent = app.addAgent({ id: "shadow-fail" });
  // 第一个按名排序的 shadow 是 hash_edit，失败后不登记到 scoped。
  assert.equal(app.host.scoped.get(agent.id)?.has("hash_edit"), false);
  assert.equal(
    (
      agent.emit("tools/pre-execute", { name: "hash_edit" }, () => ({
        kind: "allow",
      })) as { kind: string }
    ).kind,
    "deny",
  );
  await app.executeText({ names: ["hash_edit"] }, undefined, agent.id);
  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "hash_edit" }, () => ({
      kind: "allow",
    })),
    { kind: "allow" },
  );
  assert.ok(
    app.host.logs.some((entry) => entry.message.includes("短定义注册失败")),
  );
});

test("tools/change 不补 shadow；已注销工具撤 shadow，重复广播幂等", () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "shadow-change" });
  const before = app.host.scoped.get(agent.id)?.size ?? 0;

  app.host.addSchema({ name: "late_plain", description: "晚注册普通工具。" });
  assert.equal(app.host.scoped.get(agent.id)?.has("late_plain"), false);
  assert.equal(app.host.scoped.get(agent.id)?.size, before);

  app.host.emit("tools/change");
  assert.equal(app.host.scoped.get(agent.id)?.size, before);
});

test("tools/change 重算 deny 失败：移除运行时并回退宿主默认", () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "change-deny-fail" });
  assert.equal(app.host.scoped.get(agent.id)?.has("consult_tools"), true);
  app.host.failNextRestrict("change boom");
  app.host.addDefinition({
    name: "late_when_fail",
    description: "晚注册条件工具。",
    parameters: {},
    execute: () => ({}),
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: () => [],
    },
    when: () => false,
  });
  assert.equal(
    app.host.scoped.get(agent.id)?.has("consult_tools") ?? false,
    false,
  );
  assert.equal(app.host.activeDeny(agent.id), undefined);
  assert.ok(
    app.host.logs.some((entry) => entry.message.includes("条件工具隐藏失败")),
  );
});

test("catalog 自检：已包装定义缺 catalog 项时整体不接管", () => {
  resetSurfaceCatalog();
  const wrapped = wrapToolDefinition(
    STANDARD_DEFINITIONS[0] ?? {
      name: "bash",
      description: "bash",
      parameters: {},
      execute: () => ({}),
      output: {
        schema: { type: "object", additionalProperties: true, properties: {} },
        render: () => [],
      },
    },
  );
  assert.equal(isWrappedDefinition(wrapped), true);
  const app = assemble({
    definitions: STANDARD_DEFINITIONS.map((definition) => ({ ...definition })),
  });
  // 把全局第一条替换成已包装定义，再清空 catalog 制造缺项。
  app.host.tools.definitions = () => [
    wrapped,
    ...STANDARD_DEFINITIONS.slice(1),
  ];
  resetSurfaceCatalog();
  app.apply();
  const agent = app.addAgent({ id: "wrapped-missing" });
  assert.equal(app.host.restrictCalls.length, 0);
  assert.equal(app.host.scoped.get(agent.id)?.size ?? 0, 0);
  assert.ok(
    app.host.logs.some((entry) => entry.message.includes("不在本地 catalog")),
  );
});
