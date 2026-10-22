/**
 * src/main.ts — herdr-use 插件入口（DSH bundle 接入面）
 *
 * 职责：
 *   1. **可用性判定**：二进制可解析（`resolveHerdrBin`）+ 服务端可达（`herdr status --json` 探活）
 *      才启用；`HERDR_*` 全部可选（dsh 不一定跑在 herdr 内：tmux / 普通终端也可用）。探活失败只记
 *      一行日志、不注册（注册必然失败的工具只会诱使模型反复试错）。
 *   2. **工具注册**：单个模型侧工具 `herdr_use`（`src/tools.ts`；action 分派十三个动作，
 *      其中 tab 三动作落在插件内部按会话绑定的 workspace 里）。
 *   3. **沙箱门（闸④）与审批门（闸③）**：注册 `tools/pre-execute` 监听器 —— 会话处于
 *      `read-only` 时对写类动作直接返回 `{kind:"deny", reason}`（先于审批，不弹面板）；
 *      对「对非本插件创建的 pane / tab 动输入 / 关闭」返回 `{kind:"ask", reason}`（缺省档 `foreign`）；
 *      跨 workspace 的 tab 直接拒绝（模型层没有 workspace 概念，只有本会话内部绑定的一份）。
 *      用宿主既有 ask 门而不是自己调 `ctx.approval`——审计对由宿主写入、无审批服务时自动 fail-closed。
 *   4. **退出清理**：`closeOnExit` 时用 `spawnSync` 同步尽力关闭登记过的 pane，随后若本会话
 *      workspace 已空则由程序内部 `workspace close`（决策项 9a）。
 *      dsh 的 TUI 退出路径不触发 cordis dispose，故同时挂 `process.once("exit")`。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（`export { name, inject, Config, apply }`）：本包导出
 * name / inject / apply，Config 以类型别名给出（无运行时 schema，宿主不校验，配置原样透传给
 * apply；缺省 / 非法值由 `resolveConfig` 回退）。
 */

import {
  createDefaultRunner,
  DEFAULT_PROBE_TIMEOUT_MS,
  probeHerdrServerSync,
  readHerdrHandshake,
  resolveHerdrBin,
} from "./cli.ts";
import type { HerdrProbeResult, HerdrRunner } from "./cli.ts";
import type { DispatchDeps } from "./actions.ts";
import {
  crossWorkspaceDenialReason,
  makeGuardChecker,
  makeSandboxModeReader,
  needsApproval,
  sandboxDenialReason,
} from "./policy.ts";
import type { GuardChecker, SandboxModeReader } from "./policy.ts";
import { PaneRegistry, createExitCleanup } from "./registry.ts";
import type { ExitCleanup } from "./registry.ts";
import {
  createNetConnector,
  createPaneReader,
  createTimersClock,
  defaultHerdrSocketPath,
  realClock,
} from "./socket.ts";
import type { Clock, PaneReader, SocketConnector } from "./socket.ts";
import { createDeadline, resolveClock } from "./timers.ts";
import { createHerdrUseTool, TOOL_NAME } from "./tools.ts";
import { ALL_ACTIONS, resolveConfig } from "./types.ts";
import type {
  HerdrHandshake,
  HerdrUseAction,
  HerdrUseConfig,
  PaneOwnership,
  ResolvedConfig,
} from "./types.ts";

/** 插件名（bundle 标识，`cordis.patch.yml` 的 insert 条目同名）。 */
export const name = "herdr-use";

/** 注入面：tools（注册 herdr_use）；guard / approval 经 `ctx.get` 惰性解析，不进 inject。 */
export const inject = ["tools"];

/** `Config` 契约别名（仅类型级；无运行时 schema，宿主不校验）。 */
export type Config = HerdrUseConfig;

/** cordis Context 的结构面（窄化访问，不引入 `@deepseek-ai/*` 类型）。 */
export interface PluginCtxLike {
  on(
    event: string,
    listener: (...args: unknown[]) => unknown,
  ): (() => boolean) | void;
  // 结构面窄化：get 只取宿主服务对象（运行时未注册则 undefined），由调用方按名断言
  get?(name: string): object | undefined;
  // effect 注册副作用函数，fn 返回 disposer；调用时不消费返回值
  effect?(fn: () => () => void): void;
  tools?: { register(def: unknown): unknown };
}

/** 测试注入面（生产路径全部用真实实现）。 */
export interface HerdrUseDeps {
  /** 替代握手读取（单测用；缺省读 `process.env` 并解析二进制）。 */
  readHandshake?: (
    env: NodeJS.ProcessEnv,
    explicitBin?: string,
  ) => HerdrHandshake | undefined;
  /** 替代服务端探活（单测用；缺省 `herdr status --json`）。 */
  probe?: (binPath: string, timeoutMs: number) => HerdrProbeResult;
  /** 替代 CLI 执行面（单测用记录器）。 */
  runner?: HerdrRunner;
  /** 替代 socket 读通道（单测用假连接器）。 */
  reader?: PaneReader;
  /** 替代 socket 连接器（与 reader 二选一）。 */
  connector?: SocketConnector;
  /** 替代时钟（stable 判稳单测用）。 */
  clock?: Clock;
  /** 替代 guard 复查器（单测断言 deny / fail-open）。 */
  guardCheck?: GuardChecker;
  /** 替代沙箱模式读取器（单测断言只读拒绝 / fail-open）。 */
  sandboxMode?: SandboxModeReader;
  /** 环境变量（缺省 `process.env`）。 */
  env?: NodeJS.ProcessEnv;
  /** 告警出口（缺省写 stderr；单测用记录器）。 */
  warn?: (message: string) => void;
}

/** 插件句柄。 */
export interface HerdrUseHandle {
  /** 登记表（真机脚本与库面消费者可读）。 */
  registry: PaneRegistry;
  /** 归一化配置。 */
  config: ResolvedConfig;
  /** 动作派发依赖（库面消费者可直接调 `dispatchAction(action, args, deps)`）。 */
  deps: DispatchDeps;
  /** 退出清理面。 */
  cleanup: ExitCleanup;
  /** 解绑事件与清理（幂等）。 */
  dispose(): void;
}

/** pre-execute 门返回形态（宿主 `PreToolDecision` 的子集：放行 / 转审批 / 拒绝）。 */
export type PreExecuteVerdict =
  | { kind: "allow" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

/**
 * `tools/pre-execute` 的载荷结构面（宿主 `ToolExecution` 的子集）。
 * 字段名以宿主为准：`name` / `arguments` / `agent`（`dsh-tools` 的 `createExecution`）。
 */
export interface PreExecuteExecution {
  name?: string;
  arguments?: unknown;
  agent?: { session?: unknown };
}

/** pre-execute 门需要的上下文。 */
export interface PreExecuteOptions {
  registry: PaneRegistry;
  config: ResolvedConfig;
  /** 沙箱模式读取器（缺省接宿主的 `ctx.sandboxPolicy`）。 */
  sandboxMode: SandboxModeReader;
  /** 调用者所在 tab id（`HERDR_TAB_ID`；拒绝关闭调用者 tab 的防御性护栏）。 */
  callerTabId?: string;
}

/** 参数面读取：宿主给的是已解析对象，非对象按空参数处理。 */
function argumentsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 参数面取非空字符串 id。 */
function idOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * pre-execute 门判定（纯函数，便于单测），两道：
 *   1. **沙箱门（闸④）**：只读会话里的写类动作直接拒绝（先于审批，不弹面板）；
 *   2. **审批门（闸③）**：对非本插件创建的 pane / tab 动输入 / 关闭时转人工。
 *
 * tab 目标另加两条硬拒：跨本会话 workspace、以及调用者自己所在的 tab（防御性）。
 * 注意这里**不**拒绝未登记 pane / tab——归属拒绝由动作层给结构化回执（含放行方式），
 * 审批门只负责「要不要打断人」；两层判定目的不同，不重复拦。
 * 目标不在参数面（`pane_create` / `pane_list` / `tab_create` / `tab_list`，或漏给 id）时放行交动作层。
 */
export function preExecuteVerdict(
  execution: PreExecuteExecution,
  options: PreExecuteOptions,
): PreExecuteVerdict {
  if (execution.name !== TOOL_NAME) return { kind: "allow" };
  const args = argumentsOf(execution.arguments);
  const action = args.action;
  if (
    typeof action !== "string" ||
    !ALL_ACTIONS.includes(action as HerdrUseAction)
  ) {
    return { kind: "allow" };
  }
  const typedAction = action as HerdrUseAction;
  const paneId = idOf(args.pane_id);
  const tabId = idOf(args.tab_id);
  const targetId = paneId ?? tabId;
  if (targetId === undefined) return { kind: "allow" };
  // pane_wait 只有 stable 模式算写侧；其余按 policy.ts 的输入 / 关闭集合
  const stabilized = typedAction === "pane_wait" && args.stable === true;

  // 闸④：只读会话里写类动作直接拒绝（不弹审批）
  const sandboxMode = options.sandboxMode(execution.agent?.session);
  if (sandboxMode !== undefined) {
    const denial = sandboxDenialReason(
      sandboxMode,
      typedAction,
      targetId,
      stabilized,
    );
    if (denial !== undefined) return { kind: "deny", reason: denial };
  }

  // tab 目标：先按登记与 workspace 归属判（模型层没有 workspace 概念，只有内部绑定）
  if (paneId === undefined) {
    if (typedAction === "tab_close" && tabId !== undefined) {
      if (options.callerTabId !== undefined && tabId === options.callerTabId) {
        return {
          kind: "deny",
          reason:
            `tab ${tabId} 是调用者自己所在的 tab（HERDR_TAB_ID），` +
            "关闭它会连 dsh 自己的界面一起关掉。",
        };
      }
      const record = options.registry.tab(tabId);
      const binding = options.registry.workspaceBinding;
      if (
        record !== undefined &&
        binding !== undefined &&
        record.workspaceId !== binding.workspaceId
      ) {
        return { kind: "deny", reason: crossWorkspaceDenialReason(tabId) };
      }
      const tabOwnership: PaneOwnership =
        record === undefined ? "foreign" : "registered";
      if (
        !needsApproval(
          typedAction,
          tabOwnership,
          options.config.requireApproval,
        )
      ) {
        return { kind: "allow" };
      }
      return {
        kind: "ask",
        reason:
          `herdr_use tab_close 关闭非本插件登记（或不在当前 workspace）的 tab ${tabId}` +
          `（requireApproval="${options.config.requireApproval}"）。` +
          "关闭 tab 会关掉它里面的 pane，跑在 dsh 进程之外。",
      };
    }
    return { kind: "allow" };
  }

  const ownership: PaneOwnership = options.registry.has(paneId)
    ? "registered"
    : "foreign";
  const effective: HerdrUseAction = stabilized ? "pane_send_text" : typedAction;
  if (!needsApproval(effective, ownership, options.config.requireApproval)) {
    return { kind: "allow" };
  }
  return {
    kind: "ask",
    reason:
      `herdr_use ${typedAction} 作用于非本插件创建的 pane ${paneId}` +
      `（requireApproval="${options.config.requireApproval}"）。` +
      "该命令会在 herdr 服务端的 pane 里执行，跑在 dsh 进程之外、不受文件沙箱约束。",
  };
}

/**
 * 组装插件（可用性判定 + 注册 + 审批门 + 退出清理）。
 * 二进制不可解析 / 服务端不可达 / 注册面不可用时返回 undefined（不产生任何副作用）。
 */
export function createHerdrPlugin(
  ctx: PluginCtxLike,
  config: HerdrUseConfig = {},
  deps: HerdrUseDeps = {},
): HerdrUseHandle | undefined {
  const warn =
    deps.warn ??
    ((message: string): void => {
      process.stderr.write(`[${name}] warn: ${message}\n`);
    });
  const env = deps.env ?? process.env;
  const readHandshake = deps.readHandshake ?? readHerdrHandshake;
  const handshake = readHandshake(env);
  if (handshake === undefined) {
    warn(
      "未找到 herdr 二进制（显式配置 / HERDR_BIN_PATH / PATH 均不可用），" +
        "herdr_use 工具不注册",
    );
    return undefined;
  }
  const resolved = resolveConfig(config);
  // 决策项 10：二进制可解析 + 服务端可达才注册；HERDR_* 全部可选（tmux / 普通终端也能用）
  const probe = deps.probe ?? probeHerdrServerSync;
  let probed: HerdrProbeResult;
  try {
    probed = probe(
      handshake.binPath,
      Math.min(resolved.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
    );
  } catch (error) {
    warn(`herdr 服务端探活抛错，herdr_use 工具不注册：${String(error)}`);
    return undefined;
  }
  if (!probed.ok) {
    warn(
      `herdr 服务端不可达（探活失败：${probed.reason ?? "未知原因"}），` +
        "herdr_use 工具不注册",
    );
    return undefined;
  }
  const socketPath =
    handshake.socketPath ?? probed.socketPath ?? defaultHerdrSocketPath(env);

  // 工具面与库面共用同一份依赖（真机脚本 / 编排类插件可拿 handle.deps 复调）
  const registry = new PaneRegistry(resolved.label);
  // 定时器统一面（可选服务）：装配期解析一次；缺失时回落进程内定时器并只告警一次。
  // 操作级超时（CLI / socket）走 deadline（卸载时立即收尾）；判稳 sleep 用 detached 排期器
  // （被卸载撤销会让等待的 Promise 永不结算）。
  const timers = resolveClock(ctx, warn);
  const deadline = createDeadline(timers.scoped, ctx);
  const runner =
    deps.runner ?? createDefaultRunner(handshake.binPath, deadline);
  const connector = deps.connector ?? createNetConnector(deadline);
  const reader =
    deps.reader ??
    createPaneReader({ socketPath, timeoutMs: resolved.timeoutMs }, connector);
  const guardCheck: GuardChecker =
    deps.guardCheck ?? makeGuardChecker(ctx, warn);
  const sandboxMode: SandboxModeReader =
    deps.sandboxMode ?? makeSandboxModeReader(ctx, warn);
  const dispatchDeps: DispatchDeps = {
    config: resolved,
    runner,
    reader,
    registry,
    ...(handshake.callerPaneId === undefined
      ? {}
      : { callerPaneId: handshake.callerPaneId }),
    ...(handshake.callerTabId === undefined
      ? {}
      : { callerTabId: handshake.callerTabId }),
    guardCheck,
    ...(deps.clock === undefined
      ? {
          clock: timers.fromClock
            ? createTimersClock(timers.detached)
            : realClock,
        }
      : { clock: deps.clock }),
  };
  const tool = createHerdrUseTool(dispatchDeps);

  const tools = ctx.tools;
  if (tools === undefined || typeof tools.register !== "function") {
    warn("ctx.tools 不可用，herdr_use 工具未注册");
    return undefined;
  }
  try {
    tools.register(tool);
  } catch (error) {
    warn(`工具注册失败：${String(error)}`);
    return undefined;
  }

  // 闸④ / 闸③：只读会话直接拒绝写类动作；越界动输入 / 关闭走宿主 ask 门
  const unlisten = ctx.on("tools/pre-execute", ((
    execution: unknown,
    next: () => Promise<unknown>,
  ) => {
    const verdict: PreExecuteVerdict = preExecuteVerdict(
      (execution ?? {}) as PreExecuteExecution,
      {
        registry,
        config: resolved,
        sandboxMode,
        ...(handshake.callerTabId === undefined
          ? {}
          : { callerTabId: handshake.callerTabId }),
      },
    );
    if (verdict.kind !== "allow") {
      // 不调 next()（waterfall 语义：不调即截断）：ask 由宿主路由到审批 UI，deny 渲染成失败结果
      return verdict;
    }
    return next();
  }) as (...args: unknown[]) => unknown);

  const cleanup = createExitCleanup(handshake.binPath, registry, resolved);
  let disposed = false;
  const cleanupAll = (): void => {
    if (disposed) return;
    disposed = true;
    cleanup.closeAllSync();
  };
  // dsh 的 TUI 退出路径（/quit → process.exit）不触发 cordis dispose，故另挂 exit 兜底
  const onExit = (): void => {
    cleanupAll();
  };
  process.once("exit", onExit);

  process.stderr.write(
    `[${name}] ready（bin=${handshake.binPath}，socket=${socketPath}，` +
      `caller=${handshake.callerPaneId ?? "-"}，caller_tab=${handshake.callerTabId ?? "-"}，` +
      `caller_workspace=${handshake.callerWorkspaceId ?? "-"}，` +
      `requireApproval=${resolved.requireApproval}，closeOnExit=${resolved.closeOnExit}）\n`,
  );

  return {
    registry,
    config: resolved,
    deps: dispatchDeps,
    cleanup,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (typeof unlisten === "function") unlisten();
      process.removeListener("exit", onExit);
      cleanup.closeAllSync();
    },
  };
}

/** 仅用于测试注入：替换二进制定位（导出以保持测试与生产同源）。 */
export { resolveHerdrBin };

/**
 * DSH 宿主按 bundle 契约调用；二进制缺失 / 服务端不可达时静默空转（只记一行日志）。
 * 第三个参数是测试注入面（宿主只传前两个）。
 */
export function apply(
  ctx: unknown,
  config: HerdrUseConfig = {},
  deps: HerdrUseDeps = {},
): (() => void) | undefined {
  const plugin = createHerdrPlugin(ctx as PluginCtxLike, config, deps);
  if (plugin === undefined) return undefined;
  const ctxAny = ctx as { effect?: (fn: () => unknown) => unknown };
  ctxAny.effect?.(() => () => {
    plugin.dispose();
  });
  return () => {
    plugin.dispose();
  };
}
