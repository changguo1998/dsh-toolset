/**
 * src/main.ts — herdr-use 插件入口（DSH bundle 接入面）
 *
 * 职责：
 *   1. **可用性判定**：二进制可解析（`resolveHerdrBin`）+ 服务端可达（`herdr status --json` 探活）
 *      才启用；`HERDR_*` 全部可选（dsh 不一定跑在 herdr 内：tmux / 普通终端也可用）。探活失败只记
 *      一行日志、不注册。
 *   2. **工具注册**：十个模型侧工具（`src/tools.ts`；`herdr_list` / `herdr_read` / `herdr_info` /
 *      `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` /
 *      `herdr_run`），工具即动作，无 `action` 参数。
 *   3. **服务面**：`ctx.provide("herdrUse", …)`，与十个工具共用同一个 `dispatchDeps`
 *      （同 registry、同写锁）；另导出 `provide = ["herdrUse"]`。
 *   4. **沙箱门**：只保留 `read-only` 会话对写类工具的拒绝（按工具名判定，未知工具不拦）；
 *      外来 pane 审批门随终端抽象删除。
 *   5. **退出清理**：`closeOnExit` 时用 `spawnSync` 同步尽力关闭登记终端（tab close），随后
 *      若某绑定 workspace 已空则由程序内部 `workspace close`。dsh 的 TUI 退出路径不触发
 *      cordis dispose，故同时挂 `process.once("exit")`。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（`export { name, inject, Config, apply }`）：本包导出
 * name / inject / provide / apply，Config 以类型别名给出（无运行时 schema）。
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
import { createBackgroundSession } from "./background.ts";
import type { BackgroundSession } from "./background.ts";
import {
  makeGuardChecker,
  makeSandboxModeReader,
  sandboxDenialReason,
} from "./policy.ts";
import type { GuardChecker, SandboxModeReader } from "./policy.ts";
import { TerminalRegistry, createExitCleanup } from "./registry.ts";
import type { ExitCleanup } from "./registry.ts";
import { createHerdrUseService } from "./service.ts";
import type { HerdrUseService } from "./service.ts";
import {
  createNetConnector,
  createPaneReader,
  createTimersClock,
  defaultHerdrSocketPath,
  realClock,
} from "./socket.ts";
import type { Clock, PaneReader, SocketConnector } from "./socket.ts";
import { createDeadline, resolveClock } from "./timers.ts";
import { createHerdrTools } from "./tools.ts";
import type { HerdrUseToolDef } from "./tools.ts";
import { BACKGROUND_SESSION, actionForTool, resolveConfig } from "./types.ts";
import type {
  HerdrHandshake,
  HerdrUseConfig,
  Lane,
  ResolvedConfig,
} from "./types.ts";

/** 插件名（bundle 标识，`cordis.patch.yml` 的 insert 条目同名）。 */
export const name = "herdr-use";

/** 注入面：tools（注册十个工具）；guard / sandboxPolicy 经 `ctx.get` 惰性解析，不进 inject。 */
export const inject = ["tools"];

/** 服务面声明（宿主据此知道本插件提供 `herdrUse`）。 */
export const provide = ["herdrUse"];

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
  // 服务面挂载（与 agent-group / auto-approve 同款）
  provide?(name: string, value: unknown): unknown;
  tools?: { register(def: unknown): unknown };
}

/** 测试注入面（生产路径全部用真实实现）。 */
export interface HerdrUseDeps {
  /** 替代握手读取（单测用；缺省读 `process.env` 并解析二进制）。 */
  readHandshake?: (
    env: NodeJS.ProcessEnv,
    explicitBin?: string,
  ) => HerdrHandshake | undefined;
  /** 替代服务端探活（单测用；缺省 `herdr status --json`；sessionName 用于后台 lane）。 */
  probe?: (
    binPath: string,
    timeoutMs: number,
    sessionName?: string,
  ) => HerdrProbeResult;
  /** 替代 CLI 执行面（单测用记录器）。 */
  runner?: HerdrRunner;
  /** 替代 socket 读通道（单测用假连接器；两 lane 共用）。 */
  reader?: PaneReader;
  /** 替代 socket 连接器（与 reader 二选一）。 */
  connector?: SocketConnector;
  /** 替代时钟（stable 判稳单测用）。 */
  clock?: Clock;
  /** 替代 guard 复查器（单测断言 deny / fail-open）。 */
  guardCheck?: GuardChecker;
  /** 替代沙箱模式读取器（单测断言只读拒绝 / fail-open）。 */
  sandboxMode?: SandboxModeReader;
  /** 替代后台会话控制器（单测用；缺省按真实探测 + detached spawn 拉起）。 */
  backgroundSession?: BackgroundSession;
  /** 环境变量（缺省 `process.env`）。 */
  env?: NodeJS.ProcessEnv;
  /** 告警出口（缺省写 stderr；单测用记录器）。 */
  warn?: (message: string) => void;
}

/** 插件句柄。 */
export interface HerdrUseHandle {
  /** 终端登记表（真机脚本与库面消费者可读）。 */
  registry: TerminalRegistry;
  /** 归一化配置。 */
  config: ResolvedConfig;
  /** 动作派发依赖（工具 / 服务面共用这一份）。 */
  deps: DispatchDeps;
  /** 服务面（与 `provide("herdrUse")` 同一份）。 */
  service: HerdrUseService;
  /** 退出清理面。 */
  cleanup: ExitCleanup;
  /** 解绑事件与清理（幂等）。 */
  dispose(): void;
}

/** pre-execute 门返回形态（宿主 `PreToolDecision` 的子集：放行 / 拒绝）。 */
export type PreExecuteVerdict =
  { kind: "allow" } | { kind: "deny"; reason: string };

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
  /** 沙箱模式读取器（缺省接宿主的 `ctx.sandboxPolicy`）。 */
  sandboxMode: SandboxModeReader;
}

/** 参数面读取：宿主给的是已解析对象，非对象按空参数处理。 */
function argumentsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 参数面取非空字符串。 */
function idOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * pre-execute 门判定（纯函数，便于单测）：只读会话里的写类工具直接拒绝。
 * 工具名 → 动作的映射在 `types.ts`；未知工具（含其它插件的工具）一律不拦。
 * 归属拒绝由动作层给结构化回执，这里只负责「只读会话要不要硬拒」。
 */
export function preExecuteVerdict(
  execution: PreExecuteExecution,
  options: PreExecuteOptions,
): PreExecuteVerdict {
  const toolName = execution.name;
  if (toolName === undefined) return { kind: "allow" };
  const action = actionForTool(toolName);
  if (action === undefined) return { kind: "allow" };
  const sandboxMode = options.sandboxMode(execution.agent?.session);
  if (sandboxMode === undefined) return { kind: "allow" };
  const args = argumentsOf(execution.arguments);
  const denial = sandboxDenialReason(
    sandboxMode,
    toolName,
    action,
    idOf(args.terminal_id),
  );
  return denial === undefined
    ? { kind: "allow" }
    : { kind: "deny", reason: denial };
}

/** 不可用 socket 的读通道（后台 socket 解析失败时给出结构化错误，而不是抛错）。 */
function unavailableReader(message: string): PaneReader {
  return {
    async readPane() {
      return { ok: false, code: "socket-error", message };
    },
  };
}

/**
 * 组装插件（可用性判定 + 十工具注册 + 服务面 + 沙箱门 + 退出清理）。
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
        "herdr 工具不注册",
    );
    return undefined;
  }
  const resolved = resolveConfig(config);
  const probe: NonNullable<HerdrUseDeps["probe"]> =
    deps.probe ??
    ((binPath, timeoutMs, sessionName) =>
      probeHerdrServerSync(binPath, timeoutMs, undefined, sessionName));
  let probed: HerdrProbeResult;
  try {
    probed = probe(
      handshake.binPath,
      Math.min(resolved.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
    );
  } catch (error) {
    warn(`herdr 服务端探活抛错，herdr 工具不注册：${String(error)}`);
    return undefined;
  }
  if (!probed.ok) {
    warn(
      `herdr 服务端不可达（探活失败：${probed.reason ?? "未知原因"}），` +
        "herdr 工具不注册",
    );
    return undefined;
  }
  const socketPath =
    handshake.socketPath ?? probed.socketPath ?? defaultHerdrSocketPath(env);

  // 工具面与服务面共用同一份依赖（真机脚本 / 编排类插件可拿 handle.deps 复调）
  const registry = new TerminalRegistry(resolved.label);
  const timers = resolveClock(ctx, warn);
  const deadline = createDeadline(timers.scoped, ctx);
  const runner =
    deps.runner ?? createDefaultRunner(handshake.binPath, deadline);
  const backgroundSession =
    deps.backgroundSession ??
    createBackgroundSession({
      binPath: handshake.binPath,
      runner,
      timeoutMs: resolved.timeoutMs,
    });
  const connector = deps.connector ?? createNetConnector(deadline);
  const foregroundReader =
    deps.reader ??
    createPaneReader({ socketPath, timeoutMs: resolved.timeoutMs }, connector);

  // background lane 的 socket 路径按 `--session dshbg` 单独解析（懒：首次用到才探活，
  // 避免只要前台就顺手建出 dshbg 会话）。
  let backgroundReader: PaneReader | undefined;
  let backgroundError: string | undefined;
  let backgroundProbed = false;
  const readerFor = async (lane: Lane): Promise<PaneReader> => {
    if (deps.reader !== undefined) return deps.reader;
    if (lane === "foreground") return foregroundReader;
    if (backgroundReader !== undefined) return backgroundReader;
    if (backgroundProbed) {
      return unavailableReader(backgroundError ?? "后台 herdr session 不可用");
    }
    backgroundProbed = true;
    const backgroundProbe = probe(
      handshake.binPath,
      Math.min(resolved.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
      BACKGROUND_SESSION,
    );
    const backgroundSocket = backgroundProbe.socketPath;
    if (!backgroundProbe.ok || backgroundSocket === undefined) {
      backgroundError =
        `后台 herdr session（${BACKGROUND_SESSION}）的 socket 不可用：` +
        (backgroundProbe.reason ?? "status 未返回 socket_path");
      return unavailableReader(backgroundError);
    }
    backgroundReader = createPaneReader(
      { socketPath: backgroundSocket, timeoutMs: resolved.timeoutMs },
      connector,
    );
    return backgroundReader;
  };

  const guardCheck: GuardChecker =
    deps.guardCheck ?? makeGuardChecker(ctx, warn);
  const sandboxMode: SandboxModeReader =
    deps.sandboxMode ?? makeSandboxModeReader(ctx, warn);
  const dispatchDeps: DispatchDeps = {
    config: resolved,
    runner,
    readerFor,
    registry,
    ...(handshake.callerPaneId === undefined
      ? {}
      : { callerPaneId: handshake.callerPaneId }),
    ...(handshake.callerTabId === undefined
      ? {}
      : { callerTabId: handshake.callerTabId }),
    guardCheck,
    backgroundSession,
    ...(deps.clock === undefined
      ? {
          clock: timers.fromClock
            ? createTimersClock(timers.detached)
            : realClock,
        }
      : { clock: deps.clock }),
  };
  const tools: HerdrUseToolDef[] = createHerdrTools(dispatchDeps);
  const service = createHerdrUseService(dispatchDeps);

  const toolRegistry = ctx.tools;
  if (
    toolRegistry === undefined ||
    typeof toolRegistry.register !== "function"
  ) {
    warn("ctx.tools 不可用，herdr 工具未注册");
    return undefined;
  }
  try {
    for (const tool of tools) toolRegistry.register(tool);
  } catch (error) {
    warn(`工具注册失败：${String(error)}`);
    return undefined;
  }
  // 防御式服务面挂载（与 auto-approve / agent-group 同款）：宿主不消费 provide 导出时仍可 get
  ctx.provide?.("herdrUse", service);

  // 沙箱门：只读会话直接拒绝写类工具（不弹审批，也没有审批门）
  const unlisten = ctx.on("tools/pre-execute", ((
    execution: unknown,
    next: () => Promise<unknown>,
  ) => {
    const verdict = preExecuteVerdict(
      (execution ?? {}) as PreExecuteExecution,
      { sandboxMode },
    );
    if (verdict.kind === "deny") {
      // 不调 next()（waterfall 语义：不调即截断），宿主渲染成失败结果
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
      `session=${handshake.sessionName ?? "-"}，caller=${handshake.callerPaneId ?? "-"}，` +
      `caller_tab=${handshake.callerTabId ?? "-"}，closeOnExit=${resolved.closeOnExit}）\n`,
  );

  return {
    registry,
    config: resolved,
    deps: dispatchDeps,
    service,
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
