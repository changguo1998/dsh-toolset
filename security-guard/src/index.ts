/**
 * security-guard 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / inject / provide / apply，Config 以类型别名给出（无运行时 schema，宿主不校验，
 * 配置原样透传给 apply；缺省/非法值沿用本包既有语义——非法规则按保守策略处理，不新增校验）。
 * @deepseek-ai/cordis 是 dsh 仓的 workspace 包（未发布 npm），故宿主 ctx 以
 * 结构化类型声明（与 memory-base 同策略）；GuardEngine 是核心（纯、可测），
 * apply 是宿主挂载入口。
 *
 * 拦截点：宿主 `tools/pre-execute` waterfall（命令下发前，见 dsh
 * packages/core/tools）。命中即返回 { kind: 'deny', reason: <回执> }，
 * 宿主将工具调用物化为带错误文本的 isError 结果、不下发命令。
 * 回执含拦截原因 + 放行方式（用户层配置 allowPatterns / allowedPaths）。
 *
 * 未登记工具（不在显式白名单内的工具）由 `unknownToolPolicy` 三态控制：`"allow"`（缺省，一律放行）/
 * `"check"`（把 watched 键下的字符串值按键类定向派发到既有两层，命中才拦） / `"deny"`（整工具拦）；
 * `unknownToolAllowlist` 在三态之前判定，命中即无条件放行（见 README「未登记工具」）。
 *
 * 另有一条**执行前复查**入口：`GuardEngine.inspectCommand(command, source)`（并挂到服务面
 * `guard`，供插件经 `ctx.get('guard')` 调用）——给「命令不在工具入参里」的场景补同口径复查
 * （如 metric-loop 的 `tick` 执行状态文件里的 `spec.measureCmd`）。
 *
 * 分层（对外面仍只有本入口）：`tool-registry.ts` 规则表 / `arg-scan.ts` 命令解析 /
 * `config.ts` 配置归一 / `receipt.ts` 回执文案 / `engine.ts` 判定；本文件只留 bundle 契约
 * （name / provide / inject / Config）与宿主挂接（createSecurityGuard / apply）。
 */
import { GuardEngine } from "./engine.ts";
import type { GuardService } from "./engine.ts";
import type { SecurityGuardConfig } from "./config.ts";

// 纯函数层与类型重新导出（测试与宿主诊断可用）
export {
  matchCommand,
  rmRecursiveRootHit,
  remotePipeShellHit,
  chmod777RootHit,
  compileAllowPatterns,
  isCommandAllowed,
  DEFAULT_COMMAND_RULES,
} from "./blacklist.ts";
export {
  checkSensitivePath,
  compileSensitiveRules,
  extractCommandPaths,
  normalizePath,
  DEFAULT_SENSITIVE_RULES,
} from "./sensitive.ts";
export { formatCommandReceipt, formatSensitiveReceipt } from "./receipt.ts";
export type { CommandRule, CommandHit } from "./blacklist.ts";
export type {
  SensitiveRule,
  SensitiveHit,
  CompiledSensitiveRule,
} from "./sensitive.ts";
export type { SecurityGuardConfig, Config } from "./config.ts";
export { resolveGuardConfig } from "./config.ts";
export { GuardEngine } from "./engine.ts";
export type { GuardRecord, PolicySnapshot, GuardService } from "./engine.ts";
export {
  UNKNOWN_TOOL_PATH_KEYS,
  UNKNOWN_TOOL_COMMAND_KEYS,
  UNKNOWN_TOOL_CODE_KEYS,
  TOOL_SURFACE,
} from "./tool-registry.ts";

/** bundle 条目 id（与 cordis.patch.yml / profile 层一致）。 */
export const name = "security-guard";
/** 只读查询面挂载声明（TUI `/guard` 经 `ctx.get('guard')` 接线，服务面接口见 GuardService）。 */
export const provide = ["guard"];

/** 依赖 services：仅工具运行时存在时挂载（对齐官方 guard/timeout-policy）。 */
export const inject = ["tools"];

/** 宿主 tools/pre-execute 水位线收到的执行对象（结构化子集）。 */
export interface PreExecuteExecution {
  readonly name: string;
  readonly arguments: unknown;
  readonly callId?: string;
  readonly agent?: unknown;
  readonly signal?: AbortSignal;
}

/** 宿主 PreToolDecision（对齐 dsh packages/core/tools）。 */
export type PreToolDecision =
  { kind: "allow" } | { kind: "deny"; reason: string };

/** 宿主最小契约（结构化子集；@deepseek-ai/cordis 的 Context 满足它）。 */
export interface GuardHost {
  on(
    event: "tools/pre-execute",
    listener: (
      exec: PreExecuteExecution,
      next: () => PreToolDecision | Promise<PreToolDecision>,
    ) => PreToolDecision | Promise<PreToolDecision>,
  ): void | (() => unknown);
  /**
   * 单调守卫注册面（宿主 `ctx.tools.guard`，同步判定、返回字符串即拒绝）；
   * 缺省 = 宿主不支持该面 → 回退 `tools/pre-execute` 监听器（见 `createSecurityGuard`）。
   */
  tools?: {
    guard(check: (exec: PreExecuteExecution) => string | undefined): unknown;
  };
  logger?(ns: string): { info(message: string): void };
}

/** 创建守卫并挂到宿主 tools/pre-execute 水位线；返回引擎与 disposer。 */
export function createSecurityGuard(
  host: GuardHost,
  config: SecurityGuardConfig = {},
): { guard: GuardEngine; dispose: () => void } {
  const engine = new GuardEngine(config);
  // 单次判定：命中返回回执（两种挂载形态共用，避免并存时判定两次、`recent()` 记两条）
  const inspect = (exec: PreExecuteExecution): string | null => {
    const receipt = engine.inspect(exec.name, exec.arguments);
    if (receipt === null) return null;
    // 日志取回执**前两行**（插件命令工具的首行是来源标注行，规则摘要紧随其后；
    // 只取首行会让日志丢掉规则 id），完整回执在工具结果文本里
    const logHead = receipt.split("\n").slice(0, 2).join(" ");
    host
      .logger?.(name)
      ?.info(`security-guard blocked tool=${exec.name}: ${logHead}`);
    return receipt;
  };
  const tools = host.tools;
  // 优先单调守卫（2026-10-07 裁定）：它排在 `tools/pre-execute` waterfall **之后**，
  // 拒绝不可被后续监听器翻盘，也不受「某监听器不调 next() 就截断整条链」影响
  if (tools !== undefined && typeof tools.guard === "function") {
    const off = tools.guard((exec) => inspect(exec) ?? undefined);
    host
      .logger?.(name)
      ?.info(
        "security-guard mounted: monotonic guard（黑名单 + 敏感文件保护）",
      );
    return {
      guard: engine,
      dispose:
        typeof off === "function"
          ? () => void (off as () => unknown)()
          : () => {},
    };
  }
  // 降级：旧宿主 / 极简 ctx 无 `tools.guard` 时沿用 waterfall 监听器（行为与旧版一致，
  // 代价是顺序可被重排、且更早的监听器不调 next() 时会被整段跳过）
  const detach = host.on("tools/pre-execute", (exec, next) => {
    const receipt = inspect(exec);
    return receipt === null ? next() : { kind: "deny", reason: receipt };
  });
  host
    .logger?.(name)
    ?.info(
      "security-guard mounted: tools/pre-execute 回退（宿主无 tools.guard；黑名单 + 敏感文件保护）",
    );
  return {
    guard: engine,
    dispose: typeof detach === "function" ? () => void detach() : () => {},
  };
}

/** bundle 入口：宿主加载后调用一次（监听器随宿主 fiber 生命周期回收）。 */
export function apply(ctx: GuardHost, config: SecurityGuardConfig = {}): void {
  const { guard } = createSecurityGuard(ctx, config);
  // 服务面挂到 ctx（防御式，与 task-engine/metric-loop 同款）：TUI /guard 查询 + 插件执行前复查
  const provideSvc = (
    ctx as { provide?: (name: string, value: unknown) => unknown }
  ).provide;
  if (typeof provideSvc === "function") {
    const service: GuardService = {
      recent: () => guard.recent(),
      policy: () => guard.policy(),
      // 外部命令复查（命令不在工具入参里的场景，如 metric-loop 的 tick）
      inspectCommand: (command: string, source?: string) =>
        guard.inspectCommand(command, source),
    };
    provideSvc("guard", service);
  }
}
