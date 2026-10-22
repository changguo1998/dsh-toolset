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
import type { HerdrUseToolDef } from "../src/tools.ts";
import {
  apply,
  createHerdrPlugin,
  inject,
  name,
  preExecuteVerdict,
} from "../src/main.ts";
import type { PreExecuteOptions } from "../src/main.ts";
import { PaneRegistry } from "../src/registry.ts";
import { resolveConfig } from "../src/types.ts";
import type {
  ActionResult,
  ResolvedConfig,
  SandboxMode,
} from "../src/types.ts";
import {
  errorEnvelope,
  fakeConnector,
  fakeExec,
  fakeHerdr,
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
function toolOf(ctx: FakeCtx): HerdrUseToolDef {
  const def = ctx.defs[0] as HerdrUseToolDef | undefined;
  assert.notEqual(def, undefined, "应注册一个工具");
  assert.equal(def?.name, TOOL_NAME);
  return def as HerdrUseToolDef;
}

/** 成功的可用性握手（二进制已解析；HERDR_* 可选）。 */
const goodHandshake = {
  binPath: "/usr/local/bin/herdr",
  socketPath: "/tmp/herdr-test.sock",
  callerPaneId: "wT1:p1",
  callerTabId: "wT1:t1",
};

/** 服务端可达（探活成功；不真起 herdr）。 */
const okProbe = (): { ok: true; socketPath: string } => ({
  ok: true,
  socketPath: "/tmp/herdr-test.sock",
});

/** 服务端不可达。 */
const badProbe = (): { ok: false; reason: string } => ({
  ok: false,
  reason: "server stopped",
});

test("bundle 契约面: name / inject 与 Config 形态", () => {
  assert.equal(name, "herdr-use");
  assert.deepEqual(inject, ["tools"]);
});

test("apply: 二进制可解析但服务端不可达时不注册（探活失败只记日志）", () => {
  const ctx = fakeCtx();
  assert.equal(
    apply(ctx, {}, { readHandshake: () => goodHandshake, probe: badProbe }),
    undefined,
  );
  assert.deepEqual(ctx.defs, []);
  assert.equal(ctx.listeners.size, 0);
  assert.deepEqual(ctx.disposers, []);
});

test("apply: 无 HERDR_* 仍注册（dsh 不必跑在 herdr 内）", () => {
  const ctx = fakeCtx();
  const plugin = apply(
    ctx,
    {},
    {
      readHandshake: () => ({ binPath: "/usr/local/bin/herdr" }),
      probe: okProbe,
      runner: fakeRunner(),
      reader: fakeReader([readOk("x")]),
    },
  );
  assert.notEqual(plugin, undefined);
  assert.equal(ctx.defs.length, 1);
  plugin?.();
});

test("createHerdrPlugin: 握手成立且服务端可达时注册 herdr_use 并挂 tools/pre-execute", () => {
  const ctx = fakeCtx();
  const runner = fakeRunner();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      probe: okProbe,
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
      readHandshake: () => undefined,
      probe: okProbe,
      env: {},
    },
  );
  assert.equal(plugin, undefined);
  assert.deepEqual(ctx.defs, []);
});

test("createHerdrPlugin: 探活抛错也不注册（不让启动期异常穿出去）", () => {
  const ctx = fakeCtx();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      probe: () => {
        throw new Error("boom");
      },
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
      probe: okProbe,
      runner: fakeRunner(),
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  assert.equal(plugin, undefined);
});

/** 固定模式的读取器（`undefined` = 无法判定）。 */
function modeOf(
  mode: SandboxMode | undefined,
): (session: unknown) => SandboxMode | undefined {
  return () => mode;
}

/** pre-execute 门的上下文（缺省按 workspace-write，避免无关用例被只读拒绝干扰）。 */
function gateOptions(
  registry: PaneRegistry,
  config: ResolvedConfig = resolveConfig({}),
  mode: SandboxMode | undefined = "workspace-write",
  callerTabId?: string,
): PreExecuteOptions {
  return {
    registry,
    config,
    sandboxMode: modeOf(mode),
    ...(callerTabId === undefined ? {} : { callerTabId }),
  };
}

test("preExecuteVerdict: 非本工具 / 无 pane / 读类动作一律放行", () => {
  const registry = new PaneRegistry("dsh-pane");
  assert.deepEqual(
    preExecuteVerdict(
      { name: "bash", arguments: { pane_id: "wT1:p9" } },
      gateOptions(registry),
    ),
    { kind: "allow" },
  );
  assert.deepEqual(
    preExecuteVerdict(
      { name: TOOL_NAME, arguments: { action: "pane_list" } },
      gateOptions(registry),
    ),
    { kind: "allow" },
  );
  assert.deepEqual(
    preExecuteVerdict(
      {
        name: TOOL_NAME,
        arguments: { action: "pane_read", pane_id: "wT1:p9" },
      },
      gateOptions(registry),
    ),
    { kind: "allow" },
  );
});

test("preExecuteVerdict: 读宿主字段名 name / arguments / agent（旧字段名不得误拦）", () => {
  const registry = new PaneRegistry("dsh-pane");
  // 旧字段名（toolName / args）在宿主载荷里不存在：即使形状抄错也不会命中本工具
  assert.deepEqual(
    preExecuteVerdict(
      {
        toolName: TOOL_NAME,
        args: { action: "pane_run", pane_id: "wT1:p9" },
      } as never,
      gateOptions(registry, resolveConfig({}), "read-only"),
    ),
    { kind: "allow" },
  );
  // 宿主形状：name + arguments + agent.session —— 只读会话下必被拒
  assert.equal(
    preExecuteVerdict(
      {
        name: TOOL_NAME,
        arguments: { action: "pane_run", pane_id: "wT1:p2" },
        agent: { session: { id: "s1" } },
      },
      gateOptions(registry, resolveConfig({}), "read-only"),
    ).kind,
    "deny",
  );
  // arguments 非对象（null / 数组 / 标量）按空参数处理，不抛错
  for (const value of [null, [], "x", 3]) {
    assert.deepEqual(
      preExecuteVerdict(
        { name: TOOL_NAME, arguments: value },
        gateOptions(registry),
      ),
      { kind: "allow" },
      String(value),
    );
  }
});

test("preExecuteVerdict: foreign 档对非自有 pane 的输入产出 ask；自有 pane 放行", () => {
  const registry = new PaneRegistry("dsh-pane");
  registry.register({ paneId: "wT1:p2" });
  const foreign = preExecuteVerdict(
    {
      name: TOOL_NAME,
      arguments: { action: "pane_run", pane_id: "wT1:p9", command: "ls" },
    },
    gateOptions(registry),
  );
  assert.equal(foreign.kind, "ask");
  assert.match(foreign.kind === "ask" ? foreign.reason : "", /wT1:p9/);
  assert.match(foreign.kind === "ask" ? foreign.reason : "", /foreign/);

  const own = preExecuteVerdict(
    {
      name: TOOL_NAME,
      arguments: { action: "pane_run", pane_id: "wT1:p2", command: "ls" },
    },
    gateOptions(registry),
  );
  assert.deepEqual(own, { kind: "allow" });
});

test("preExecuteVerdict: always 档对自有 pane 也 ask；never 档从不 ask", () => {
  const registry = new PaneRegistry("dsh-pane");
  registry.register({ paneId: "wT1:p2" });
  assert.equal(
    preExecuteVerdict(
      {
        name: TOOL_NAME,
        arguments: { action: "pane_send_keys", pane_id: "wT1:p2" },
      },
      gateOptions(registry, resolveConfig({ requireApproval: "always" })),
    ).kind,
    "ask",
  );
  assert.deepEqual(
    preExecuteVerdict(
      {
        name: TOOL_NAME,
        arguments: { action: "pane_close", pane_id: "wT1:p9" },
      },
      gateOptions(registry, resolveConfig({ requireApproval: "never" })),
    ),
    { kind: "allow" },
  );
});

test("preExecuteVerdict: pane_wait 只有 stable 模式算写侧（match 不打断人）", () => {
  const registry = new PaneRegistry("dsh-pane");
  const match = preExecuteVerdict(
    {
      name: TOOL_NAME,
      arguments: { action: "pane_wait", pane_id: "wT1:p9", match: "x" },
    },
    gateOptions(registry),
  );
  assert.deepEqual(match, { kind: "allow" });
  const stable = preExecuteVerdict(
    {
      name: TOOL_NAME,
      arguments: { action: "pane_wait", pane_id: "wT1:p9", stable: true },
    },
    gateOptions(registry),
  );
  assert.equal(stable.kind, "ask");
});

test("preExecuteVerdict: 只读会话拒绝写类动作（含 stable 的 pane_wait），读类与标记类放行", () => {
  const registry = new PaneRegistry("dsh-pane");
  registry.register({ paneId: "wT1:p2" });
  const readOnly = gateOptions(registry, resolveConfig({}), "read-only");
  const session = { id: "s1" };

  const denied = [
    { action: "pane_send_text", pane_id: "wT1:p2", text: "ls" },
    { action: "pane_send_keys", pane_id: "wT1:p2", keys: ["enter"] },
    { action: "pane_run", pane_id: "wT1:p2", command: "rm -rf build" },
    { action: "pane_close", pane_id: "wT1:p2" },
    { action: "pane_wait", pane_id: "wT1:p2", stable: true },
    { action: "tab_close", tab_id: "wT1:t2" },
  ];
  for (const args of denied) {
    const verdict = preExecuteVerdict(
      { name: TOOL_NAME, arguments: args, agent: { session } },
      readOnly,
    );
    assert.equal(verdict.kind, "deny", args.action);
    const reason = verdict.kind === "deny" ? verdict.reason : "";
    assert.match(reason, /read-only/, args.action);
    assert.match(reason, /\/permission/, args.action);
    assert.match(reason, /wT1:p2|wT1:t2/, args.action);
  }

  const allowed = [
    { action: "pane_read", pane_id: "wT1:p2" },
    { action: "pane_info", pane_id: "wT1:p2" },
    { action: "pane_list" },
    { action: "pane_label", pane_id: "wT1:p2", label: "x" },
    { action: "pane_create", direction: "right" },
    { action: "tab_create" },
    { action: "pane_wait", pane_id: "wT1:p2", match: "done" },
  ];
  for (const args of allowed) {
    assert.deepEqual(
      preExecuteVerdict(
        { name: TOOL_NAME, arguments: args, agent: { session } },
        readOnly,
      ),
      { kind: "allow" },
      args.action,
    );
  }
});

test("preExecuteVerdict: tab_close 按内部绑定判——本 workspace 登记放行、跨 workspace / 调用者 tab 拒绝", () => {
  const session = { id: "s1" };
  const registry = new PaneRegistry("dsh-pane");
  registry.setWorkspaceBinding({
    sessionId: "s1",
    workspaceId: "wT1",
    label: "proj/s1",
    cwd: "/tmp/proj",
    createdAt: Date.now(),
  });
  registry.registerTab({ tabId: "wT1:t2", workspaceId: "wT1" });
  registry.registerTab({ tabId: "wT9:t1", workspaceId: "wT9" });

  // 本 workspace 的已登记 tab：foreign 档不打断人
  assert.deepEqual(
    preExecuteVerdict(
      { name: TOOL_NAME, arguments: { action: "tab_close", tab_id: "wT1:t2" } },
      gateOptions(registry),
    ),
    { kind: "allow" },
  );
  // 跨 workspace：直接 deny（不是审批问题）
  const cross = preExecuteVerdict(
    {
      name: TOOL_NAME,
      arguments: { action: "tab_close", tab_id: "wT9:t1" },
      agent: { session },
    },
    gateOptions(registry),
  );
  assert.equal(cross.kind, "deny");
  assert.match(
    cross.kind === "deny" ? cross.reason : "",
    /不属于本会话的 workspace/,
  );
  // 调用者自己所在的 tab（防御性）
  const self = preExecuteVerdict(
    { name: TOOL_NAME, arguments: { action: "tab_close", tab_id: "wT1:t2" } },
    gateOptions(registry, resolveConfig({}), "workspace-write", "wT1:t2"),
  );
  assert.equal(self.kind, "deny");
  assert.match(self.kind === "deny" ? self.reason : "", /HERDR_TAB_ID/);
  // 未登记的 tab：交动作层拒绝，但审批门先按 foreign 档打断（与 pane 面同口径）
  assert.equal(
    preExecuteVerdict(
      { name: TOOL_NAME, arguments: { action: "tab_close", tab_id: "wT7:t1" } },
      gateOptions(registry),
    ).kind,
    "ask",
  );
  // 缺 tab_id：放行交动作层（那里给 tab-required + 放行方式）
  assert.deepEqual(
    preExecuteVerdict(
      { name: TOOL_NAME, arguments: { action: "tab_close" } },
      gateOptions(registry, resolveConfig({}), "read-only"),
    ),
    { kind: "allow" },
  );
});

test("preExecuteVerdict: tab_create / tab_list 不按审批档打断（与 create / list 同档）", () => {
  const registry = new PaneRegistry("dsh-pane");
  for (const args of [{ action: "tab_create" }, { action: "tab_list" }]) {
    assert.deepEqual(
      preExecuteVerdict(
        { name: TOOL_NAME, arguments: args },
        gateOptions(registry, resolveConfig({ requireApproval: "always" })),
      ),
      { kind: "allow" },
      args.action,
    );
  }
});

test("preExecuteVerdict: 可写模式不拒；模式无法判定时 fail-open", () => {
  const registry = new PaneRegistry("dsh-pane");
  registry.register({ paneId: "wT1:p2" });
  const payload = {
    name: TOOL_NAME,
    arguments: { action: "pane_run", pane_id: "wT1:p2", command: "ls" },
  };
  const modes = ["workspace-write", "danger-full-access", undefined] as const;
  for (const mode of modes) {
    assert.deepEqual(
      preExecuteVerdict(
        payload,
        gateOptions(registry, resolveConfig({}), mode),
      ),
      { kind: "allow" },
      String(mode),
    );
  }
});

test("preExecuteVerdict: 拒绝先于审批（只读会话里非自有 pane 不弹面板）", () => {
  const registry = new PaneRegistry("dsh-pane");
  const verdict = preExecuteVerdict(
    {
      name: TOOL_NAME,
      arguments: { action: "pane_run", pane_id: "wT1:p9", command: "ls" },
    },
    gateOptions(
      registry,
      resolveConfig({ requireApproval: "always" }),
      "read-only",
    ),
  );
  assert.equal(verdict.kind, "deny");
});

test("tools/pre-execute 监听器: 只读会话拒写类、读类继续链路", async () => {
  const ctx = fakeCtx();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      probe: okProbe,
      runner: fakeRunner(),
      reader: fakeReader([readOk("x")]),
      sandboxMode: () => "read-only",
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

  const denied = await listener?.(
    {
      name: TOOL_NAME,
      arguments: { action: "pane_run", pane_id: "wT1:p2" },
      agent: { session: { id: "s1" } },
    },
    next,
  );
  assert.equal((denied as { kind?: string }).kind, "deny");
  assert.equal(nextCalls, 0, "deny 分支不应继续链路");

  const read = await listener?.(
    { name: TOOL_NAME, arguments: { action: "pane_read", pane_id: "wT1:p9" } },
    next,
  );
  assert.equal(nextCalls, 1, "读类动作继续链路");
  assert.deepEqual(read as unknown, { kind: "allow" });
  plugin?.dispose();
});

test("tools/pre-execute 监听器: 非只读时仍按审批档产出 ask", async () => {
  const ctx = fakeCtx();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      probe: okProbe,
      runner: fakeRunner(),
      reader: fakeReader([readOk("x")]),
      sandboxMode: () => "workspace-write",
      env: {},
    },
  );
  const listener = ctx.listeners.get("tools/pre-execute")?.[0];
  plugin?.registry.register({ paneId: "wT1:p2" });

  let nextCalls = 0;
  const next = async (): Promise<unknown> => {
    nextCalls += 1;
    return { kind: "allow" };
  };

  const blocked = await listener?.(
    { name: TOOL_NAME, arguments: { action: "pane_run", pane_id: "wT1:p9" } },
    next,
  );
  assert.equal(
    (blocked as { kind?: string } | undefined)?.kind,
    "ask",
    "非自有 pane 的输入应产出 ask",
  );
  assert.equal(nextCalls, 0, "ask 分支不应继续链路");

  const allowed = await listener?.(
    { name: TOOL_NAME, arguments: { action: "pane_run", pane_id: "wT1:p2" } },
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
      probe: okProbe,
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

test("工具 execute: exec 透传 → pane_create 落在本会话 workspace 的活动 pane（全链路）", async () => {
  const ctx = fakeCtx();
  const fake = fakeHerdr();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      probe: okProbe,
      runner: fake.runner,
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  const tool = toolOf(ctx);
  const exec = fakeExec();

  // 不注入 resolveSession：create 能成即证明工具把宿主 exec 透传给了 dispatchAction
  const created = (await tool.execute(
    { action: "pane_create", direction: "right" },
    exec,
  )) as ActionResult;
  assert.equal(created.ok, true);
  const paneId = created.ok ? String(created.payload.pane_id) : "";
  assert.equal(paneId, "wT1:p2");
  // 切的是 workspace 活动 pane（wT1:p1），不是调用者 pane（wT1:p1 恰好同 id 时也要核对 argv 形态）
  assert.deepEqual(
    fake.runner.calls.find((args) => args[1] === "split"),
    [
      "pane",
      "split",
      "wT1:p1",
      "--direction",
      "right",
      "--cwd",
      "/tmp/proj",
      "--no-focus",
    ],
  );

  const ran = (await tool.execute(
    { action: "pane_run", pane_id: paneId, command: "python3 -i" },
    exec,
  )) as ActionResult;
  assert.equal(ran.ok, true);

  const info = (await tool.execute(
    { action: "pane_info", pane_id: paneId },
    exec,
  )) as ActionResult;
  assert.equal(info.ok && info.payload.running, false);

  const closed = (await tool.execute(
    { action: "pane_close", pane_id: paneId },
    exec,
  )) as ActionResult;
  assert.equal(closed.ok, true);
  assert.equal(plugin?.registry.has(paneId), false);
  plugin?.dispose();
});

test("工具 execute: 错误信封透传（pane_not_found），render 出可读文案", async () => {
  const ctx = fakeCtx();
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => goodHandshake,
      probe: okProbe,
      runner: fakeRunner(() =>
        errorEnvelope("pane_not_found", "pane not found"),
      ),
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  const tool = toolOf(ctx);
  const result = (await tool.execute({
    action: "pane_info",
    pane_id: "wT1:p999",
  })) as ActionResult;
  assert.equal(result.ok, false);
  const blocks = tool.output.render({}, result);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "text");
  assert.match(
    blocks[0]?.text ?? "",
    /herdr_use pane_info 失败\[herdr-cli-error\]/,
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
      probe: okProbe,
      runner,
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  assert.notEqual(plugin, undefined);
  plugin?.registry.register({ paneId: "wT1:p2" });
  const result = await dispatchAction(
    "pane_run",
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
      probe: okProbe,
      runner,
      reader: fakeReader([readOk("x")]),
      env: {},
    },
  );
  plugin?.registry.register({ paneId: "wT1:p2" });
  const result = await dispatchAction(
    "pane_run",
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
      probe: okProbe,
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
      probe: okProbe,
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
      probe: okProbe,
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
