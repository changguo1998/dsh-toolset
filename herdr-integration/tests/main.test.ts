// tests/main.test.ts — 插件组装与状态上报单测
//
// 用 fake ctx + 记录器 sender 注入，验证：握手禁用空转、启动期同步、
// agent/status → working/idle、ask-user / approval waterfall 观察型 blocked 桥、
// 子 agent 忽略、会话切换重新上报。
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createHerdrPlugin,
  type HerdrPluginHandle,
  type PluginCtxLike,
  type RootAgentLike,
} from "../src/main.ts";
import type {
  AgentState,
  HerdrClientOptions,
  HerdrSender,
  SessionRef,
} from "../src/herdr.ts";

const ENV_OPTS: HerdrClientOptions = {
  paneId: "p1",
  socketPath: "/tmp/herdr-test.sock",
  source: "herdr:dsh",
  agent: "dsh",
};

/** 记录 sender：同步记录所有上报。 */
class RecordingSender implements HerdrSender {
  sessions: Array<{ ref: SessionRef; source?: string }> = [];
  states: Array<{ state: AgentState; message?: string }> = [];
  private currentRef: SessionRef | undefined;

  setSessionRef(ref: SessionRef | undefined): void {
    this.currentRef = ref;
  }

  async reportSession(ref: SessionRef, source?: string): Promise<void> {
    this.sessions.push({ ref, source });
  }

  async reportState(state: AgentState, message?: string): Promise<void> {
    this.states.push(message === undefined ? { state } : { state, message });
  }
}

interface FakeCtx extends PluginCtxLike {
  roots: RootAgentLike[];
  fire(event: string, ...args: unknown[]): void;
  setRoots(roots: RootAgentLike[]): void;
}

function fakeCtx(): FakeCtx {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const ctx = {
    roots: [] as RootAgentLike[],
    on(
      event: string,
      listener: (...args: unknown[]) => unknown,
    ): () => boolean {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return () => {
        const i = arr.indexOf(listener);
        if (i >= 0) arr.splice(i, 1);
        return true;
      };
    },
    get(name: string): unknown {
      if (name === "agents") {
        return { roots: () => ctx.roots };
      }
      return undefined;
    },
    fire(event: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        const result = listener(...args);
        // 模拟 cordis 调度器：waterfall 监听者返回的 promise 由调度侧消化，
        // 下游拒答（如 NO_PROVIDER / 用户取消）不产生未处理 rejection
        if (result instanceof Promise) {
          result.catch(() => {});
        }
      }
    },
    setRoots(roots: RootAgentLike[]): void {
      ctx.roots = roots;
    },
  };
  return ctx;
}

let handle: HerdrPluginHandle | undefined;

function startPlugin(
  ctx: FakeCtx,
  opts: { enabled?: boolean } = {},
): { plugin: HerdrPluginHandle | undefined; sender: RecordingSender } {
  const sender = new RecordingSender();
  handle = createHerdrPlugin(
    ctx,
    {},
    {
      sender,
      readHerdrEnv: () => (opts.enabled === false ? undefined : ENV_OPTS),
      readRoots: () => ctx.roots,
    },
  );
  return { plugin: handle, sender };
}

describe("createHerdrPlugin", () => {
  test("握手未启用 → 返回 undefined（空转）", () => {
    const ctx = fakeCtx();
    const { plugin } = startPlugin(ctx, { enabled: false });
    assert.equal(plugin, undefined);
  });

  test("启动期同步：既有根 agent 上报会话(startup)与当前状态", () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "running" }]);
    const { plugin, sender } = startPlugin(ctx);
    assert.ok(plugin);
    // 会话上报：id + startup
    assert.deepEqual(sender.sessions, [
      { ref: { id: "s1" }, source: "startup" },
    ]);
    // 初始强制上报 working
    assert.deepEqual(sender.states, [{ state: "working" }]);
    plugin!.dispose();
  });

  test("agent/status：running → working，idle → idle（变化才上报）", () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "running" }]);
    const { plugin, sender } = startPlugin(ctx);
    assert.equal(sender.states.length, 1);

    // 同状态事件 → 不上报
    ctx.fire("agent/status", {
      agent: { session: { id: "s1" } },
      status: "running",
    });
    assert.equal(sender.states.length, 1);

    // 转 idle → 上报
    ctx.setRoots([{ session: { id: "s1" }, status: "idle" }]);
    ctx.fire("agent/status", {
      agent: { session: { id: "s1" } },
      status: "idle",
    });
    assert.deepEqual(sender.states.at(-1), { state: "idle" });

    plugin!.dispose();
  });

  test("子 agent 状态事件被忽略（不翻转面板状态、不换会话）", () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "idle" }]);
    const { plugin, sender } = startPlugin(ctx);
    const before = sender.states.length;
    // 子 agent running，根 agent 仍 idle
    ctx.fire("agent/status", {
      agent: { session: { id: "child-1" } },
      status: "running",
    });
    assert.equal(sender.states.length, before);
    assert.equal(sender.sessions.length, 1);
    plugin!.dispose();
  });

  test("ask-user waterfall pending → blocked，沉降后解除", async () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "running" }]);
    const { plugin, sender } = startPlugin(ctx);
    // 受控 next：等待我们 resolve 后才沉降
    let resolveAnswer!: (v: unknown) => void;
    const next = () =>
      new Promise<unknown>((resolve) => {
        resolveAnswer = resolve;
      });
    ctx.fire("user-questions/request", { questions: [] }, next);
    // begin 同步执行 → blocked 已上报
    assert.deepEqual(sender.states.at(-1), {
      state: "blocked",
      message: "waiting for user",
    });
    resolveAnswer({ answers: [] });
    await new Promise((r) => setImmediate(r));
    // 沉降 → 解除，回到 working
    assert.deepEqual(sender.states.at(-1), { state: "working" });
    plugin!.dispose();
  });

  test("approval waterfall pending → blocked，被下游 answerer 认领后解除", async () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "idle" }]);
    const { plugin, sender } = startPlugin(ctx);
    const next = async () => "allowed-once";
    ctx.fire("approval/request", { toolName: "bash" }, next);
    assert.deepEqual(sender.states.at(-1), {
      state: "blocked",
      message: "waiting for approval",
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sender.states.at(-1), { state: "idle" });
    plugin!.dispose();
  });

  test("approval 请求被拒绝/取消 → 同样解除阻塞", async () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "running" }]);
    const { plugin, sender } = startPlugin(ctx);
    let reject!: (e: unknown) => void;
    const next = () =>
      new Promise<unknown>((_resolve, rej) => {
        reject = rej;
      });
    ctx.fire("approval/request", {} as never, next);
    assert.deepEqual(sender.states.at(-1), {
      state: "blocked",
      message: "waiting for approval",
    });
    reject(new Error("rejected"));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sender.states.at(-1), { state: "working" });
    plugin!.dispose();
  });

  test("并发阻塞：ask-user + approval 同时 pending，全部解除才释放", async () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "running" }]);
    const { plugin, sender } = startPlugin(ctx);
    let resolveUser!: (v: unknown) => void;
    let resolveApproval!: (v: unknown) => void;
    ctx.fire(
      "user-questions/request",
      { questions: [] },
      () =>
        new Promise<unknown>((resolve) => {
          resolveUser = resolve;
        }),
    );
    ctx.fire(
      "approval/request",
      {},
      () =>
        new Promise<unknown>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    // 两个来源都 begin → blocked（message 取最近一次 begin）
    assert.deepEqual(sender.states.at(-1), {
      state: "blocked",
      message: "waiting for approval",
    });
    // 先解除一个 → 仍 blocked（另一个还在）
    resolveUser({ answers: [] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sender.states.at(-1), {
      state: "blocked",
      message: "waiting for approval",
    });
    // 全部解除 → working
    resolveApproval("allowed-once");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sender.states.at(-1), { state: "working" });
    plugin!.dispose();
  });

  test("blocked 优先于 working 的状态推导", async () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "running" }]);
    const { plugin, sender } = startPlugin(ctx);
    let resolveApproval!: (v: unknown) => void;
    ctx.fire(
      "approval/request",
      {},
      () =>
        new Promise<unknown>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    assert.deepEqual(sender.states.at(-1), {
      state: "blocked",
      message: "waiting for approval",
    });
    resolveApproval("rejected");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sender.states.at(-1), { state: "working" });
    plugin!.dispose();
  });

  test("会话切换（新根 agent 换 id）→ 再次上报会话", async () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "running" }]);
    const { plugin, sender } = startPlugin(ctx);
    assert.deepEqual(sender.sessions, [
      { ref: { id: "s1" }, source: "startup" },
    ]);
    // resume 到新会话
    ctx.setRoots([{ session: { id: "s2" }, status: "running" }]);
    ctx.fire("agent/status", {
      agent: { session: { id: "s2" } },
      status: "running",
    });
    assert.equal(sender.sessions.length, 2);
    assert.deepEqual(sender.sessions[1], {
      ref: { id: "s2" },
      source: undefined,
    });
    plugin!.dispose();
  });

  test("dispose 卸载监听（事件不再上报）", async () => {
    const ctx = fakeCtx();
    ctx.setRoots([{ session: { id: "s1" }, status: "idle" }]);
    const { plugin, sender } = startPlugin(ctx);
    plugin!.dispose();
    const before = sender.states.length;
    ctx.setRoots([{ session: { id: "s1" }, status: "running" }]);
    ctx.fire("agent/status", {
      agent: { session: { id: "s1" } },
      status: "running",
    });
    assert.equal(sender.states.length, before);
  });
});
