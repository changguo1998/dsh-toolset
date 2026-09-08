// tests/policy.test.ts — P2 阶段 C：审批策略两态切换（/policy）+ 当前策略展示
//
// 覆盖：adapter 归一化 approval/policy → approval-policy（含 seq 守卫与非活跃会话）；
// reducer policyBySession 按 sessionId latest-wins + 会话隔离；layout 状态栏策略徽标
// （ask / never→auto / 缺省省略）；routeSlashCommand /policy；App /policy 显式/无参
// toggle、宿主缺失 ctx.approval 时 notice「审批策略服务不可用」不崩溃。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { routeSlashCommand } from "../src/app/commands.ts";
import { renderStatusColumn } from "../src/app/layout.ts";
import { createRealDshAdapter } from "../src/app/adapter/dsh.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type {
  DshRuntime,
  DshAgentLike,
  DshUserMessageLike,
} from "../src/app/adapter/types.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { RenderLine, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

// ---------- layout：策略徽标 ----------

test("renderStatusColumn: policy ask → 行列出 ask/auto（ask 生效）；never → auto 生效；缺省省略", () => {
  const theme = initialState().themeId;
  const strip = (policy: "ask" | "never" | undefined): string =>
    renderStatusColumn(
      undefined,
      [],
      undefined,
      0,
      6,
      30,
      theme,
      undefined,
      policy,
      undefined,
    )
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
      .join("\n");
  const ask = strip("ask");
  assert.ok(
    ask.includes("policy ask auto"),
    "ask 策略行列出 ask/auto 可选项: " + ask,
  );
  const auto = strip("never");
  assert.ok(
    auto.includes("policy ask auto"),
    "never 策略行仍列出 ask/auto（auto 为生效项，着色在原始行）: " + auto,
  );
  const none = strip(undefined);
  assert.ok(
    !none.includes("policy") && !none.includes("Mode"),
    "无 policy 时 Mode 块（含 policy 行）省略: " + none,
  );
});

// ---------- commands：路由 ----------

test("routeSlashCommand: /policy → policy；未知命令仍回 registry", () => {
  assert.equal(routeSlashCommand("policy"), "policy");
  assert.equal(routeSlashCommand("bogus"), "registry");
});

// ---------- reducer：policyBySession 隔离 + latest-wins ----------

test("approval-policy reducer：按 sessionId latest-wins，会话互不泄漏", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "approval-policy",
    sessionId: "s1",
    policy: "ask",
  });
  s = reduceState(s, {
    type: "approval-policy",
    sessionId: "s1",
    policy: "never",
  });
  s = reduceState(s, {
    type: "approval-policy",
    sessionId: "s2",
    policy: "ask",
  });
  assert.equal(s.policyBySession["s1"], "never", "s1 保留最近一条");
  assert.equal(s.policyBySession["s2"], "ask");
  assert.equal(initialState().policyBySession["s1"], undefined, "初始无策略");
});

// ---------- adapter 归一化（真实 dsh.ts 写路径） ----------

class FakeRuntime implements DshRuntime {
  private listeners = new Map<string, Set<(...a: unknown[]) => unknown>>();
  private seqCounter = new Map<string, number>();
  on(
    event: string,
    listener: (...args: unknown[]) => unknown,
  ): (() => void) | void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }
  /** session/event 自动把 seq 规范为按 sessionId 单调递增（兼容固定 seq 写法） */
  fire(event: string, ...args: unknown[]): unknown {
    if (
      event === "session/event" &&
      args.length >= 2 &&
      args[1] !== null &&
      typeof args[1] === "object" &&
      typeof (args[1] as { seq?: unknown }).seq === "number"
    ) {
      const session = args[0] as { id?: string } | null;
      const key = session?.id ?? "?";
      const next = (this.seqCounter.get(key) ?? 0) + 1;
      this.seqCounter.set(key, next);
      args = [args[0], { ...(args[1] as object), seq: next }];
    }
    return this.dispatch(event, args);
  }
  /** 原样转发，供 seq 守卫测试注入重复/倒序 */
  fireRaw(event: string, ...args: unknown[]): unknown {
    return this.dispatch(event, args);
  }
  private dispatch(event: string, args: unknown[]): unknown {
    const set = this.listeners.get(event);
    if (!set) return undefined;
    let last: unknown;
    for (const cb of [...set]) {
      const r = cb(...args);
      if (r !== undefined) last = r;
    }
    return last;
  }
}

class FakeAgent implements DshAgentLike {
  session = { id: "s1" };
  followup(_m: DshUserMessageLike): void {}
}

function makePolicyAdapter() {
  const runtime = new FakeRuntime();
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: new FakeAgent(),
    approvalTimeoutMs: 50,
  });
  const events: DshEvent[] = [];
  const unbind = adapter.onEvent((e) => events.push(e));
  return { runtime, adapter, events, unbind };
}

test("approval/policy 归一化为 approval-policy（ask/never；无效载荷丢弃）", () => {
  const t = makePolicyAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    {
      type: "approval/policy",
      seq: 1,
      time: 1,
      data: { policy: "ask" },
    },
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    {
      type: "approval/policy",
      seq: 2,
      time: 1,
      data: { policy: "never" },
    },
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    {
      type: "approval/policy",
      seq: 3,
      time: 1,
      data: { policy: "always" as "ask" | "never" },
    },
  );
  assert.deepEqual(t.events, [
    { type: "approval-policy", sessionId: "s1", policy: "ask" },
    { type: "approval-policy", sessionId: "s1", policy: "never" },
  ]);
});

test("approval/policy 走 seq 守卫：同 seq 重复/倒序丢弃", () => {
  const t = makePolicyAdapter();
  const ev = (seq: number, policy: "ask" | "never") => ({
    type: "approval/policy" as const,
    seq,
    time: 1,
    data: { policy },
  });
  t.runtime.fireRaw("session/event", { id: "s1" }, ev(5, "ask"));
  t.runtime.fireRaw("session/event", { id: "s1" }, ev(5, "never")); // 同 seq 重复
  t.runtime.fireRaw("session/event", { id: "s1" }, ev(3, "never")); // 倒序
  assert.deepEqual(t.events, [
    { type: "approval-policy", sessionId: "s1", policy: "ask" },
  ]);
});

test("approval/policy 非当前活跃会话事件丢弃", () => {
  const t = makePolicyAdapter();
  t.runtime.fire(
    "session/event",
    { id: "other" },
    {
      type: "approval/policy",
      seq: 1,
      time: 1,
      data: { policy: "ask" },
    },
  );
  assert.deepEqual(t.events, []);
});

// ---------- App：/policy 命令 ----------

class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  renders = 0;
  refreshes = 0;
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  lastRender: string[] = [];
  render(lines: RenderLine[]): void {
    this.lastRender = lines.map((l) => l.text);
    this.renders++;
  }
  refresh(_lines: RenderLine[]): void {
    this.refreshes++;
  }
  onKey(cb: (k: KeyEvent) => void): void {
    this.press = cb;
  }
  emitKey(k: KeyEvent): void {
    this.press(k);
  }
  onResize(cb: (cols: number, rows: number) => void): void {
    this.resize = cb;
  }
  getSize(): Size {
    return this.size;
  }
  themeCalls: ThemeId[] = [];
  setTheme(id: ThemeId): void {
    this.themeCalls.push(id);
  }
  close(): void {
    this.closed++;
  }
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;
}

class FakePolicyAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  policies: ("ask" | "never")[] = [];
  /** 宿主缺失 ctx.approval 模拟：setApprovalPolicy 置 undefined */
  setApprovalPolicy: ((p: "ask" | "never") => Promise<void>) | undefined =
    async (p) => {
      this.policies.push(p);
    };
  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }
  sendMessage(): void {}
  runCommand(): void {}
  approve(): void {}
  answerQuestion(): void {}
  cancelQuestion(): void {}
  interrupt(): void {}
  modelCatalog() {
    return Promise.resolve({
      providers: [],
      models: [],
      current: { provider: "p", model: "m" },
    });
  }
  setSessionModel(sel: ModelSelection): Promise<ModelSelection> {
    return Promise.resolve(sel);
  }
  modelEfforts() {
    return Promise.resolve([{ id: "low", name: "low" }]);
  }
  push(e: DshEvent): void {
    for (const cb of this.cbs) cb(e);
  }
}

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function frames(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("/policy never：显式设置 → adapter.setApprovalPolicy('never') + notice", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakePolicyAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/policy never");
  await tick();
  assert.deepEqual(adapter.policies, ["never"], "adapter 收到显式设置");
  assert.ok(
    frames(renderer).includes("审批策略：never（工具调用自动放行）"),
    "notice 入帧: " + frames(renderer),
  );
});

test("/policy 无参：打开状态选项面板——空格预选、Enter 提交并关闭", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakePolicyAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/policy");
  await tick();
  const f0 = frames(renderer);
  assert.ok(f0.includes("/policy 审批策略"), "面板标题: " + f0);
  assert.ok(f0.includes("ask") && f0.includes("never"), "两项选项: " + f0);
  assert.deepEqual(adapter.policies, [], "打开面板不直接生效（防误改）");
  // ↓ 到 never → 空格预选 → Enter 提交并关闭
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: " ", ctrl: false, meta: false, shift: false });
  const f1 = frames(renderer);
  assert.ok(f1.includes("* never"), "预选星号落在 never: " + f1);
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await tick();
  assert.deepEqual(adapter.policies, ["never"], "Enter 提交预选");
  assert.ok(!frames(renderer).includes("/policy 审批策略"), "提交后关闭面板");
  app.dispose();
});

test("/policy 显式 ask 覆盖：adapter 收到 ask", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakePolicyAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/policy ask");
  await tick();
  assert.deepEqual(adapter.policies, ["ask"]);
  assert.ok(frames(renderer).includes("审批策略：ask（每次工具调用询问）"));
});

test("/policy：宿主未挂载 ctx.approval（adapter 缺失方法）→ notice 服务不可用，不崩溃", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakePolicyAdapter();
  adapter.setApprovalPolicy = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/policy never");
  await tick();
  assert.deepEqual(adapter.policies, []);
  assert.ok(
    frames(renderer).includes("审批策略服务不可用"),
    "缺失宿主应提示不可用: " + frames(renderer),
  );
});

test("/policy 非法参数 → 用法提示（不调 adapter）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakePolicyAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/policy wat");
  await tick();
  assert.deepEqual(adapter.policies, []);
  assert.ok(frames(renderer).includes("用法：/policy [ask|never]"));
});
