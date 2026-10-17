/**
 * tests/main.test.ts — 插件入口：握手判定、工具注册、审批门、退出清理
 *
 * fake ctx 只实现本包实际消费的三件事：`on`（收监听器）、`tools.register`（收工具定义）、
 * `get`（服务面）。所有副作用都在内存里，不碰真机 herdr。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchAction } from "../src/actions.ts";
import { TOOL_NAME } from "../src/tools.ts";
import type { HerdrPaneToolDef } from "../src/tools.ts";
import {
  apply,
  createHerdrPlugin,
  inject,
  name,
  preExecuteVerdict,
} from "../src/main.ts";
import { PaneRegistry } from "../src/registry.ts";
import { resolveConfig } from "../src/types.ts";
import type { ActionResult } from "../src/types.ts";
import {
  errorEnvelope,
  fakeConnector,
  fakeReader,
  fakeRunner,
  okEnvelope,
  readOk,
} from "./helpers.ts";

/** pre-execute 监听器形态（宿主 waterfall）。 */
interface Listener {
  (...args: unknown[]): unknown;
}

/** 记录型 fake ctx。 */
interface FakeCtx {
  tools: { register(def: unknown): void };
  on(event: string, listener: Listener): () => boolean;
  get(name: string): object | undefined;
  effect(fn: () => () => void): void;
  /** 已注册的工具定义。 */
  defs: unknown[];
  /** 已注册的事件监听器。 */
  listeners: Map<string, Listener[]>;
  /** 已注册的 effect 清理函数（dispose 链）。 */
  disposers: Array<() => void>;
}

/** 构造 fake ctx。 */
function fakeCtx(services: Record<string, object> = {}): FakeCtx {
  const ctx: FakeCtx = {
    defs: [],
    listeners: new Map(),
    disposers: [],
    tools: {
      register: (def) => ctx.defs.push(def),
    },
    on(event, listener) {
      const list = ctx.listeners.get(event) ?? [];
      list.push(listener);
      ctx.listeners.set(event, list);
      return (): boolean => {
        const current = ctx.listeners.get(event) ?? [];
        ctx.listeners.set(
          event,
          current.filter((item) => item !== listener),
        );
        return true;
      };
    },
    get: (serviceName) => services[serviceName],
    effect: (fn) => {
      ctx.disposers.push(fn());
    },
  };
  return ctx;
}

/** 校验一个 decode 成功的工具定义。 */
function toolOf(ctx: FakeCtx): HerdrPaneToolDef {
  const def = ctx.defs[0] as HerdrPaneToolDef | undefined;
  assert.notEqual(def, undefined, "应注册一个工具");
  assert.equal(def?.name, TOOL_NAME);
  return def as HerdrPaneToolDef;
}

/** 成功的握手（bin 用 `/bin/true` 之外的假值即可——本项目不真起 CLI，除非显式注入 runner）。 */
const goodHandshake = {
  socketPath: "/tmp/herdr-test.sock",
  callerPaneId: "wT1:p1",
  binPath: "/usr/local/bin/herdr",
};

test("bundle 契约面: name / inject 与 Config 形态", () => {
  assert.equal(name, "herdr-pane");
  assert.deepEqual(inject, ["tools"]);
});

test("apply: 未在 herdr 内（握手缺一）不注册工具、只记一行日志", () => {
  const ctx = fakeCtx();
  assert.equal(apply(ctx, {}), undefined);
  assert.deepEqual(ctx.defs, []);
  assert.equal(ctx.listeners.size, 0);
  assert.deepEqual(ctx.disposers, []);
});

test("createHerdrPlugin: 握手成立时注册 herdr_pane 并挂 tools/pre-execute", () => {
  const ctx = fakeCtx();
  const runner = fakeRunner();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      runner,
      reader: fakeReader([readOk("x", { revision: 1 })]),
      env: {},
    },
  );
  assert.notEqual(plugin, undefined);
  assert.equal(ctx.defs.length, 1);
  assert.equal(ctx.listeners.get("tools/pre-execute")?.length, 1);
  assert.equal(plugin?.config.label, "dsh-pane");
  assert.equal(plugin?.config.closeOnExit, true);
  plugin?.dispose();
  // dispose 幂等
  plugin?.dispose();
});

test("createHerdrPlugin: 二进制解析不到时不注册（能力不可用就不占工具面）", () => {
  const ctx = fakeCtx();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => ({
        socketPath: "/tmp/s.sock",
        callerPaneId: "wT1:p1",
      }),
      env: {},
    },
  );
  assert.equal(plugin, undefined);
  assert.deepEqual(ctx.defs, []);
});

test("createHerdrPlugin: ctx.tools 缺失时告警并返回 undefined", () => {
  const ctx = fakeCtx();
  const noTools = { ...ctx, tools: undefined } as unknown as FakeCtx;
  const plugin = createHerdrPlugin(
    noTools,
    {},
    {
      readHandshake: () => goodHandshake,
      runner: fakeRunner(),
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  assert.equal(plugin, undefined);
});

test("preExecuteVerdict: 非本工具 / 无 pane / 读类动作一律放行", () => {
  const registry = new PaneRegistry("dsh-pane");
  const config = resolveConfig({});
  assert.deepEqual(
    preExecuteVerdict(
      { toolName: "bash", args: { pane_id: "wT1:p9" } },
      registry,
      config,
    ),
    { kind: "allow" },
  );
  assert.deepEqual(
    preExecuteVerdict(
      { toolName: TOOL_NAME, args: { action: "list" } },
      registry,
      config,
    ),
    { kind: "allow" },
  );
  assert.deepEqual(
    preExecuteVerdict(
      { toolName: TOOL_NAME, args: { action: "read", pane_id: "wT1:p9" } },
      registry,
      config,
    ),
    { kind: "allow" },
  );
});

test("preExecuteVerdict: foreign 档对非自有 pane 的输入产出 ask；自有 pane 放行", () => {
  const registry = new PaneRegistry("dsh-pane");
  registry.register({ paneId: "wT1:p2" });
  const config = resolveConfig({});
  const foreign = preExecuteVerdict(
    {
      toolName: TOOL_NAME,
      args: { action: "run", pane_id: "wT1:p9", command: "ls" },
    },
    registry,
    config,
  );
  assert.equal(foreign.kind, "ask");
  assert.match(foreign.kind === "ask" ? foreign.reason : "", /wT1:p9/);
  assert.match(foreign.kind === "ask" ? foreign.reason : "", /foreign/);

  const own = preExecuteVerdict(
    {
      toolName: TOOL_NAME,
      args: { action: "run", pane_id: "wT1:p2", command: "ls" },
    },
    registry,
    config,
  );
  assert.deepEqual(own, { kind: "allow" });
});

test("preExecuteVerdict: always 档对自有 pane 也 ask；never 档从不 ask", () => {
  const registry = new PaneRegistry("dsh-pane");
  registry.register({ paneId: "wT1:p2" });
  const always = resolveConfig({ requireApproval: "always" });
  assert.equal(
    preExecuteVerdict(
      { toolName: TOOL_NAME, args: { action: "send_keys", pane_id: "wT1:p2" } },
      registry,
      always,
    ).kind,
    "ask",
  );
  const never = resolveConfig({ requireApproval: "never" });
  assert.deepEqual(
    preExecuteVerdict(
      { toolName: TOOL_NAME, args: { action: "close", pane_id: "wT1:p9" } },
      registry,
      never,
    ),
    { kind: "allow" },
  );
});

test("preExecuteVerdict: wait 只有 stable 模式算写侧（match 不打断人）", () => {
  const registry = new PaneRegistry("dsh-pane");
  const config = resolveConfig({});
  const match = preExecuteVerdict(
    {
      toolName: TOOL_NAME,
      args: { action: "wait", pane_id: "wT1:p9", match: "x" },
    },
    registry,
    config,
  );
  assert.deepEqual(match, { kind: "allow" });
  const stable = preExecuteVerdict(
    {
      toolName: TOOL_NAME,
      args: { action: "wait", pane_id: "wT1:p9", stable: true },
    },
    registry,
    config,
  );
  assert.equal(stable.kind, "ask");
});

test("tools/pre-execute 监听器: 命中 ask 直接返回、否则 next() 放行", async () => {
  const ctx = fakeCtx();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      runner: fakeRunner(),
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  const listener = ctx.listeners.get("tools/pre-execute")?.[0];
  assert.notEqual(listener, undefined);
  plugin?.registry.register({ paneId: "wT1:p2" });

  let nextCalls = 0;
  const next = async (): Promise<unknown> => {
    nextCalls += 1;
    return { kind: "allow" };
  };

  const blocked = await listener?.(
    { toolName: TOOL_NAME, args: { action: "run", pane_id: "wT1:p9" } },
    next,
  );
  assert.equal(
    (blocked as { kind?: string } | undefined)?.kind,
    "ask",
    "非自有 pane 的输入应产出 ask",
  );
  assert.equal(nextCalls, 0, "ask 分支不应继续链路");

  const allowed = await listener?.(
    { toolName: TOOL_NAME, args: { action: "run", pane_id: "wT1:p2" } },
    next,
  );
  assert.equal(nextCalls, 1);
  assert.deepEqual(allowed as unknown, { kind: "allow" });
  plugin?.dispose();
});

test("工具 execute: 缺 action 返回 unknown-action（不触达 runner）", async () => {
  const ctx = fakeCtx();
  const runner = fakeRunner();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      runner,
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  const tool = toolOf(ctx);
  const result = (await tool.execute({})) as ActionResult;
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "unknown-action");
  assert.equal(runner.calls.length, 0);
  plugin?.dispose();
});

test("工具 execute: 动作直达 dispatchAction（create → run → info → close 全链路）", async () => {
  const ctx = fakeCtx();
  const calls: string[][] = [];
  const runner = fakeRunner((args) => {
    calls.push(args);
    if (args[1] === "split") return okEnvelope({ pane: { pane_id: "wT1:p2" } });
    if (args[1] === "process-info") {
      return okEnvelope({
        process_info: {
          pane_id: "wT1:p2",
          shell_pid: 10,
          foreground_processes: [],
        },
      });
    }
    return okEnvelope({});
  });
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      runner,
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  const tool = toolOf(ctx);

  const created = (await tool.execute({
    action: "create",
    direction: "right",
  })) as ActionResult;
  assert.equal(created.ok, true);
  assert.equal(created.ok && created.payload.pane_id, "wT1:p2");

  const ran = (await tool.execute({
    action: "run",
    pane_id: "wT1:p2",
    command: "python3 -i",
  })) as ActionResult;
  assert.equal(ran.ok, true);

  const info = (await tool.execute({
    action: "info",
    pane_id: "wT1:p2",
  })) as ActionResult;
  assert.equal(info.ok && info.payload.running, false);

  const closed = (await tool.execute({
    action: "close",
    pane_id: "wT1:p2",
  })) as ActionResult;
  assert.equal(closed.ok, true);
  assert.equal(plugin?.registry.has("wT1:p2"), false);
  // 建 / 打标 / run / info / close 都真的走了 runner
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["split", "rename", "run", "process-info", "close"],
  );
  plugin?.dispose();
});

test("工具 execute: 错误信封透传（pane_not_found），render 出可读文案", async () => {
  const ctx = fakeCtx();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      runner: fakeRunner(() =>
        errorEnvelope("pane_not_found", "pane not found"),
      ),
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  const tool = toolOf(ctx);
  const result = (await tool.execute({
    action: "info",
    pane_id: "wT1:p999",
  })) as ActionResult;
  assert.equal(result.ok, false);
  const blocks = tool.output.render({}, result);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "text");
  assert.match(
    blocks[0]?.text ?? "",
    /herdr_pane info 失败\[herdr-cli-error\]/,
  );
  assert.match(blocks[0]?.text ?? "", /pane_not_found/);
  plugin?.dispose();
});

test("guard 复查接线：deny 时命令不送达 pane（服务面走 ctx.get('guard')）", async () => {
  const ctx = fakeCtx({
    guard: {
      inspectCommand: () => "[security-guard] blocked by rule",
    },
  });
  const runner = fakeRunner();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      runner,
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  assert.notEqual(plugin, undefined);
  plugin?.registry.register({ paneId: "wT1:p2" });
  const result = await dispatchAction(
    "run",
    { pane_id: "wT1:p2", command: "dangerous-cmd" },
    plugin?.deps as never,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "guard-denied");
  assert.equal(runner.calls.length, 0);
  plugin?.dispose();
});

test("guard 复查接线：服务缺失时 fail-open，命令照常送达", async () => {
  const ctx = fakeCtx();
  const runner = fakeRunner();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      runner,
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  plugin?.registry.register({ paneId: "wT1:p2" });
  const result = await dispatchAction(
    "run",
    { pane_id: "wT1:p2", command: "echo hi" },
    plugin?.deps as never,
  );
  assert.equal(result.ok, true);
  assert.equal(runner.calls.length, 1);
  plugin?.dispose();
});

test("退出清理: closeOnExit=true 时 dispose 后登记表清空；false 时保留现场", () => {
  const ctx = fakeCtx();
  const config = resolveConfig({ closeOnExit: false });
  const plugin = createHerdrPlugin(
    ctx,
    { closeOnExit: false },
    {
      readHandshake: () => goodHandshake,
      runner: fakeRunner(),
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  plugin?.registry.register({ paneId: "wT1:p2" });
  plugin?.dispose();
  // closeOnExit=false：登记表清空但不尝试关闭（现场保留在 herdr 里）
  assert.equal(plugin?.registry.panes.length, 0);
  assert.equal(config.closeOnExit, false);

  const onCtx = fakeCtx();
  const onPlugin = createHerdrPlugin(
    onCtx,
    {},
    {
      readHandshake: () => goodHandshake,
      runner: fakeRunner(),
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  assert.equal(onPlugin?.config.closeOnExit, true);
  onPlugin?.dispose();
});

test("socket 读通道经连接器注入（main 组装 reader 时用配置的超时）", async () => {
  const ctx = fakeCtx();
  const connector = fakeConnector([
    {
      kind: "data",
      text: JSON.stringify({
        id: "x",
        result: {
          type: "pane_read",
          read: { text: "hello", revision: 2, truncated: false },
        },
      }),
    },
  ]);
  const plugin = createHerdrPlugin(
    ctx,
    { timeoutMs: 2222 },
    {
      readHandshake: () => goodHandshake,
      runner: fakeRunner(),
      connector,
      env: {},
    },
  );
  const read = await plugin?.deps.reader.readPane({
    paneId: "wT1:p2",
    source: "visible",
  });
  assert.equal(read?.ok, true);
  assert.equal(read?.ok && read.read.text, "hello");
  assert.equal(connector.requests[0]?.timeoutMs, 2222);
  plugin?.dispose();
});
