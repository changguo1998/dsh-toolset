import assert from "node:assert/strict";
import { test } from "node:test";

import { assemble } from "./assemble.ts";
import { resetSurfaceCatalog } from "@dsh-toolset/tool-surface";

function fresh(options: Parameters<typeof assemble>[0] = {}) {
  resetSurfaceCatalog();
  return assemble(options);
}

test("服务形状不符: tools / agents 缺失时插件不启用且不挂监听", () => {
  for (const options of [
    { toolsService: false, withAgentTools: false },
    { agentsService: false },
  ] as const) {
    const app = fresh(options);
    app.apply();
    assert.equal(app.host.listenerCount(), 0);
    assert.ok(
      app.host.logs.some((entry) => entry.message.includes("宿主缺少 tools")),
    );
  }
});

test("日志面缺失 / 抛错 / 缺方法都不影响主流程", () => {
  for (const [index, options] of [
    { withLogger: false },
    { loggerThrows: true },
    { loggerPartial: true },
  ].entries()) {
    const app = fresh(options);
    assert.doesNotThrow(() => app.apply());
    const agent = app.addAgent({ id: `log-${index}` });
    assert.doesNotThrow(() => app.host.emit("agent/created", { agent }));
    assert.ok((app.host.scoped.get(agent.id)?.size ?? 0) > 0);
    app.dispose();
  }
});

test("agent/created 载荷异常: 缺代理 / id 非字符串 / 缺 ctx 都跳过", () => {
  const app = fresh();
  app.apply();
  app.host.emit("agent/created", undefined);
  app.host.emit("agent/created", {});
  app.host.emit("agent/created", { agent: { id: 1 } });
  app.host.emit("agent/created", { agent: { id: "no-ctx" } });
  assert.equal(app.host.restrictCalls.length, 0);
  assert.equal(app.tools.names().length, 0);
});

test("无 agent 作用域: 本代理不接管并告警, 不复用旧运行时", () => {
  const app = fresh({ withAgentTools: false });
  app.apply();
  const agent = app.addAgent({ id: "no-scope" });
  assert.equal(agent.session.id, "no-scope");
  assert.equal(app.host.restrictCalls.length, 0);
  assert.equal(app.tools.names().length, 0);
  assert.ok(
    app.host.logs.some((entry) => entry.message.includes("本代理不接管")),
  );
});

test("服务面名集与本地 catalog 不一致: 整体不接管", () => {
  const app = fresh({
    serviceValues: {
      toolSurface: {
        lookup: () => undefined,
        list: () => [{ name: "ghost", description: "", parameters: {} }],
      },
    },
  });
  app.apply();
  const agent = app.addAgent({ id: "catalog-mismatch" });
  assert.equal(app.host.restrictCalls.length, 0);
  assert.equal(app.tools.names().length, 0);
  assert.ok(
    app.host.logs.some((entry) => entry.message.includes("名集不一致")),
  );
  assert.equal(agent.session.id, "catalog-mismatch");
});

test("初始集未命中 / 含白名单外条件工具: 各告警一次并按隐藏处理", () => {
  const app = fresh();
  app.apply({ initialTools: ["ghost_*", "team_task_list", "bash"] });
  const agent = app.addAgent({ id: "initial-warn" });
  const visible = (app.host.tools.schemas({ id: agent.id }) ?? []).map(
    (schema) => schema.name,
  );
  assert.ok(visible.includes("bash"));
  assert.equal(visible.includes("team_task_list"), false);
  assert.equal(app.host.scoped.get(agent.id)?.has("team_task_list"), false);
  const warnings = app.host.logs.filter((entry) => entry.level === "warn");
  assert.equal(
    warnings.filter((entry) => entry.message.includes("未命中任何工具")).length,
    1,
  );
  assert.equal(
    warnings.filter((entry) => entry.message.includes("白名单外条件工具"))
      .length,
    1,
  );
});

test("agent/disposed 撤注册；插件卸载撤 hold / 监听 / 注册", async () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "dispose-root" });
  await app.executeText({ names: ["hash_read"] }, undefined, agent.id);
  assert.ok(app.pinNotes.keys().includes("revealed:hash_read"));

  app.host.emit("agent/disposed", { agent });
  assert.equal(app.host.scoped.get(agent.id)?.size ?? 0, 0);
  assert.equal(
    app.pinNotes.text("revealed:hash_read", agent.id),
    undefined,
    "运行时移除后 hold provider 返回 undefined",
  );

  const next = app.addAgent({ id: "dispose-next" });
  await app.executeText({ names: ["task_status"] }, undefined, next.id);
  app.dispose();
  assert.equal(app.pinNotes.keys().length, 0);
  assert.equal(app.host.listenerCount(), 0);
  assert.equal(app.host.scoped.get(next.id)?.size ?? 0, 0);
});

test("disposer 抛错被吞掉，卸载仍完成", () => {
  const app = fresh({ disposeThrows: true, listenerDisposeThrows: true });
  app.apply();
  const agent = app.addAgent({ id: "dispose-throws" });
  assert.ok((app.host.scoped.get(agent.id)?.size ?? 0) > 0);
  assert.doesNotThrow(() => app.dispose());
  assert.equal(app.host.scoped.get(agent.id)?.size ?? 0, 0);
});

test("配置热重载: 重复 apply 不叠加 deny 调用", () => {
  const app = fresh();
  app.apply();
  app.addAgent({ id: "reload-call" });
  app.apply();
  assert.equal(
    app.host.restrictCalls.filter((call) => !call.disposed).length,
    1,
  );
});
