// tests/integration/plugin.test.ts — 集成层: `apply` 与宿主接线
//
// 用假宿主 ctx(事件面 / 服务面 / 生命周期面) 加本机临时 unix socket 拼 `apply`, 断言:
// 事件订阅面、启动期同步与事件投影的 canonical 报文值、`agents` / `clock` 服务面读取、
// 发送失败与卸载路径。仅 socket 收包与失败沉降等真实时间, 一律带超时守卫。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  apply,
  inject,
  name,
  type HerdrIntegrationConfig,
  type RootAgentLike,
} from "../../src/index.ts";
import { COMPACTING_MESSAGE } from "../../src/state.ts";
import {
  clearHerdrEnv,
  createFakeClock,
  createFakeHost,
  createFakeTimers,
  delay,
  lastState,
  messagesByMethod,
  setHerdrEnv,
  startHerdrUpstream,
  waitFor,
  type FakeHost,
  type HerdrUpstream,
} from "../assemble.ts";

const upstreams: HerdrUpstream[] = [];
const restores: Array<() => void> = [];
const tempDirs: string[] = [];

after(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const upstream of upstreams.splice(0)) {
    await upstream.close();
    upstream.cleanup();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 起一个受管上游(用例结束后由 `after` 统一关闭)。 */
async function upstream(): Promise<HerdrUpstream> {
  const started = await startHerdrUpstream();
  upstreams.push(started);
  return started;
}

/** 最小装配: 上游 socket + `agents` 服务 + apply(缺省关掉周期补发)。 */
async function startPlugin(
  options: {
    roots?: () => RootAgentLike[];
    services?: Record<string, unknown>;
    config?: HerdrIntegrationConfig;
  } = {},
): Promise<{ host: FakeHost; upstream: HerdrUpstream }> {
  const server = await upstream();
  const host = createFakeHost({
    agents: { roots: options.roots ?? (() => []) },
    ...options.services,
  });
  restores.push(setHerdrEnv(server.socketPath));
  await apply(host.ctx, { refreshIntervalMs: 0, ...options.config });
  return { host, upstream: server };
}

describe("apply: 入口与宿主接线", () => {
  test("握手不全: 不注册监听与卸载效果, 也不连 socket", async () => {
    restores.push(clearHerdrEnv());
    const host = createFakeHost({});
    await apply(host.ctx);
    assert.deepEqual(host.events(), []);
    assert.equal(host.effectCount(), 0);
  });

  test("入口契约: 导出 name 与 inject", () => {
    assert.equal(name, "herdr-integration");
    assert.deepEqual(inject, ["agents"]);
  });

  test("握手完成: 注册四个事件监听与一次 fiber 卸载效果", async () => {
    const { host } = await startPlugin();
    assert.deepEqual(host.events().sort(), [
      "agent/status",
      "approval/request",
      "session/event",
      "user-questions/request",
    ]);
    for (const event of host.events()) {
      assert.equal(host.listenerCount(event), 1, `${event} 只注册一次`);
    }
    // 至少一条卸载效果: apply 注册的 dispose(在途发送的 deadline 另注册一条, 随请求收尾撤销)
    assert.ok(host.effectCount() >= 1);
    host.unload();
  });

  test("启动期同步: 经真实 socket 上报会话(startup)与 working, 卸载后发 release", async () => {
    const { host, upstream: server } = await startPlugin({
      roots: () => [{ session: { id: "s-it" }, status: "running" }],
    });
    await server.waitForMessages(2);

    const [session] = messagesByMethod(server, "pane.report_agent_session");
    assert.ok(session, "应有 pane.report_agent_session");
    assert.equal(session.params?.pane_id, "pane-it");
    assert.equal(session.params?.source, "dsh");
    assert.equal(session.params?.agent, "dsh");
    assert.equal(session.params?.agent_session_id, "s-it");
    assert.equal(session.params?.session_start_source, "startup");
    assert.equal(typeof session.params?.seq, "number");

    const state = lastState(server);
    assert.equal(state?.state, "working");
    assert.equal(state?.pane_id, "pane-it");
    assert.equal(state?.agent_session_id, "s-it");

    host.unload();
    await waitFor(
      () => messagesByMethod(server, "pane.release_agent").length >= 1,
    );
    assert.equal(host.listenerCount("agent/status"), 0);
    // 卸载后事件不再投影
    const before = server.messages.length;
    host.fire("agent/status", {
      agent: { session: { id: "s-it" } },
      status: "idle",
    });
    assert.equal(server.messages.length, before);
  });
});

describe("apply: 事件投影", () => {
  test("agent/status: 根 agent 活跃度变化投影为 working / idle", async () => {
    let roots: RootAgentLike[] = [{ session: { id: "s1" }, status: "running" }];
    const { host, upstream: server } = await startPlugin({
      roots: () => roots,
    });
    await server.waitForMessages(2);

    roots = [{ session: { id: "s1" }, status: "idle" }];
    host.fire("agent/status", {
      agent: { session: { id: "s1" } },
      status: "idle",
    });
    await waitFor(() => lastState(server)?.state === "idle");

    roots = [{ session: { id: "s1" }, status: "running" }];
    host.fire("agent/status", {
      agent: { session: { id: "s1" } },
      status: "running",
    });
    await waitFor(() => lastState(server)?.state === "working");
    host.unload();
  });

  test("提问 / 审批: 观察型阻塞桥投影为 blocked, 沉降后解除", async () => {
    const { host, upstream: server } = await startPlugin({
      roots: () => [{ session: { id: "s1" }, status: "idle" }],
    });
    await server.waitForMessages(2);

    // 提问 pending: begin 先上报 blocked, 沉降后回到 idle
    let answer!: (value: unknown) => void;
    const pending = host.fire(
      "user-questions/request",
      { questions: [] },
      () =>
        new Promise<unknown>((resolve) => {
          answer = resolve;
        }),
    );
    await waitFor(() => lastState(server)?.state === "blocked");
    assert.equal(lastState(server)?.message, "waiting for user");
    answer({ answers: [] });
    await Promise.all(pending);
    await waitFor(() => lastState(server)?.state === "idle");

    // 审批 pending: 观察者不认领请求, 由下游答案者收尾后解除
    let decide!: (value: unknown) => void;
    const approval = host.fire(
      "approval/request",
      { toolName: "bash" },
      () =>
        new Promise<unknown>((resolve) => {
          decide = resolve;
        }),
    );
    await waitFor(() => lastState(server)?.state === "blocked");
    assert.equal(lastState(server)?.message, "waiting for approval");
    decide("allowed-once");
    await Promise.all(approval);
    await waitFor(() => lastState(server)?.state === "idle");
    host.unload();
  });

  test("session/event: turn 阻塞 / 压缩在途 / 重新开始", async () => {
    const { host, upstream: server } = await startPlugin({
      roots: () => [{ session: { id: "s1" }, status: "idle" }],
    });
    await server.waitForMessages(2);

    host.fire(
      "session/event",
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "blocked" } },
    );
    await waitFor(() => lastState(server)?.state === "blocked");
    assert.equal(lastState(server)?.message, "waiting for input");

    host.fire(
      "session/event",
      { id: "s1" },
      { type: "turn/start", data: { turn: 2 } },
    );
    await waitFor(() => lastState(server)?.state === "idle");

    host.fire(
      "session/event",
      { id: "s1" },
      { type: "compaction/start", data: { compactionId: "c1" } },
    );
    await waitFor(() => lastState(server)?.message === COMPACTING_MESSAGE);
    assert.equal(lastState(server)?.state, "working");

    host.fire(
      "session/event",
      { id: "s1" },
      { type: "compaction/end", data: { compactionId: "c1" } },
    );
    await waitFor(() => lastState(server)?.state === "idle");
    host.unload();
  });
});

describe("apply: 服务面缺失与失败路径", () => {
  test("agents 服务缺席: 只上报状态, 不产生会话上报", async () => {
    const server = await upstream();
    const host = createFakeHost({});
    restores.push(setHerdrEnv(server.socketPath));
    await apply(host.ctx, { refreshIntervalMs: 0 });
    await server.waitForMessages(1);

    assert.equal(
      messagesByMethod(server, "pane.report_agent_session").length,
      0,
    );
    assert.equal(lastState(server)?.state, "idle");
    host.unload();
  });

  test("agents.roots 返回非数组: 按无根 agent 处理", async () => {
    const server = await upstream();
    const host = createFakeHost({ agents: { roots: () => null } });
    restores.push(setHerdrEnv(server.socketPath));
    await apply(host.ctx, { refreshIntervalMs: 0 });
    await server.waitForMessages(1);

    assert.equal(
      messagesByMethod(server, "pane.report_agent_session").length,
      0,
    );
    assert.equal(lastState(server)?.state, "idle");
    host.unload();
  });

  test("socket 不可达: 上报失败被吞, 监听仍在且卸载不抛", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-it-miss-"));
    tempDirs.push(dir);
    const host = createFakeHost({
      agents: { roots: () => [{ session: { id: "s1" }, status: "running" }] },
    });
    restores.push(setHerdrEnv(join(dir, "absent.sock")));
    await apply(host.ctx, { refreshIntervalMs: 0, attemptTimeoutMs: 20 });
    assert.equal(host.listenerCount("agent/status"), 1);

    host.fire(
      "session/event",
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: "blocked" } },
    );
    host.fire("agent/status", {
      agent: { session: { id: "s1" } },
      status: "running",
    });
    // 让两次失败的发送尝试收尾(连接错误立即返回, 不抛给调用方)
    await delay(80);
    assert.equal(host.listenerCount("agent/status"), 1);
    host.unload();
  });

  test("clock 服务可用: 排期走服务面, 卸载撤销并上报 release", async () => {
    const timers = createFakeTimers();
    const clock = createFakeClock(timers);
    const { host, upstream: server } = await startPlugin({
      roots: () => [{ session: { id: "c1" }, status: "idle" }],
      services: { clock: clock.service },
      config: { refreshIntervalMs: 1000 },
    });
    // 两组排期器: 绑定本插件 ctx 与不绑定
    assert.deepEqual(clock.scopes, [host.ctx, undefined]);
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0]?.delayMs, 1000);

    await server.waitForMessages(2);
    // 发送超时走注入的 deadline: 每条尝试在响应到达后被撤销
    await waitFor(
      () =>
        timers.scheduled.length >= 1 &&
        timers.scheduled.every((timer) => timer.canceled),
    );

    host.unload();
    assert.equal(timers.intervals[0]?.canceled, true);
    await waitFor(
      () => messagesByMethod(server, "pane.release_agent").length >= 1,
    );
  });
});
