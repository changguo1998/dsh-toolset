/**
 * security-guard 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 DSH-CTX-API.md §0：bundle 约定为 `export { name, inject, Config, apply }`。
 * @deepseek-ai/cordis 是 dsh 仓的 workspace 包（未发布 npm），故宿主 ctx 以
 * 结构化类型声明（与 knowledge-base 同策略）；GuardEngine 是核心（纯、可测），
 * apply 是宿主挂载入口。
 *
 * 拦截点：宿主 `tools/pre-execute` waterfall（命令下发前，见 dsh
 * packages/core/tools）。命中即返回 { kind: 'deny', reason: <回执> }，
 * 宿主将工具调用物化为带错误文本的 isError 结果、不下发命令。
 * 回执含拦截原因 + 放行方式（用户层配置 allowPatterns / allowedPaths）。
 */
import { homedir } from "node:os";
import {
  compileAllowPatterns,
  isCommandAllowed,
  matchCommand,
  DEFAULT_COMMAND_RULES,
  type CommandRule,
} from "./blacklist.ts";
import {
  checkSensitivePath,
  compileSensitiveRules,
  extractCommandPaths,
  normalizePath,
  DEFAULT_SENSITIVE_RULES,
  type CompiledSensitiveRule,
  type SensitiveRule,
} from "./sensitive.ts";
import { formatCommandReceipt, formatSensitiveReceipt } from "./receipt.ts";

// 纯函数层与类型重新导出（测试与宿主诊断可用）
export {
  matchCommand,
  splitCommandSegments,
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

/** bundle 条目 id（与 cordis.patch.yml / profile 层一致）。 */
export const name = "security-guard";

/** 依赖 services：仅工具运行时存在时挂载（对齐官方 guard/timeout-policy）。 */
export const inject = ["tools"];

/** 用户层配置（profile 的 cordis.patch.yml 在 security-guard 条目下 config 键）。 */
export interface SecurityGuardConfig {
  /** 总开关（默认 true）。 */
  enabled?: boolean;
  /** 家目录展开用（默认 os.homedir()；测试可注入）。 */
  homeDir?: string;
  /** 命令黑名单层（bash/shell/run_code 的命令文本）。 */
  commandBlacklist?: {
    /** 层开关（默认 true）。 */
    enabled?: boolean;
    /** 追加的用户层规则（正则源）；默认规则不可移除，只能追加。 */
    rules?: readonly string[];
    /** 放行正则源：命令文本匹配任一则跳过黑名单层（不放开敏感文件层）。 */
    allowPatterns?: readonly string[];
  };
  /** 敏感文件层（shell 命令文本中的路径 + 内置文件工具的路径参数）。 */
  sensitiveFiles?: {
    /** 层开关（默认 true）。 */
    enabled?: boolean;
    /** 追加的保护路径条目（字面前缀或 glob，见 sensitive.ts 语义）。 */
    rules?: readonly string[];
    /** 放行的路径（字面前缀或 glob；命中则该路径跳过敏感文件层）。 */
    allowedPaths?: readonly string[];
  };
}

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
  logger?(ns: string): { info(message: string): void };
}

/** 拦截面：shell 工具 → command 文本；run_code → code 文本；文件工具 → 路径参数。 */
const SHELL_TOOLS = new Set(["bash", "shell", "pwsh"]);
const RUN_CODE_TOOLS = new Set(["run_code"]);
const FILE_TOOLS = new Set(["read", "write", "edit", "patch", "grep", "glob"]);
const FILE_PATH_KEYS = ["file_path", "path", "target", "file"] as const;
const WRITE_FILE_TOOLS = new Set(["write", "edit", "patch"]);

/** 解析后的内部配置（编译后，构造一次）。 */
interface ResolvedConfig {
  enabled: boolean;
  home: string;
  commandBlacklist: {
    enabled: boolean;
    rules: readonly CommandRule[];
    allowPatterns: readonly RegExp[];
  };
  sensitiveFiles: {
    enabled: boolean;
    rules: readonly CompiledSensitiveRule[];
    allowedPaths: readonly CompiledSensitiveRule[];
  };
}

function asStringRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** 文件工具的敏感文件操作面：写类工具 → write；shell → 读写两面；其余 → read。 */
function toolOperation(toolName: string): "read" | "write" | "read-write" {
  if (SHELL_TOOLS.has(toolName)) return "read-write";
  if (WRITE_FILE_TOOLS.has(toolName)) return "write";
  return "read";
}

function firstString(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** 解析用户配置为编译后的内部配置（默认值 + 用户层合并）。 */
export function resolveGuardConfig(
  config: SecurityGuardConfig,
): ResolvedConfig {
  const home = config.homeDir ?? homedir();
  // 命令黑名单：默认规则 + 用户追加（id 稳定，便于回执定位）
  const userCommandRules: CommandRule[] = (
    config.commandBlacklist?.rules ?? []
  ).map((pattern, i) => ({
    id: `user-rule-${i + 1}`,
    reason: `命中用户层自定义黑名单规则 #${i + 1}`,
    pattern,
  }));
  const commandRules = [...DEFAULT_COMMAND_RULES, ...userCommandRules];
  // 敏感文件：默认清单 + 用户追加（追加条目 id 为 user-path-N）
  const userPathRules: SensitiveRule[] = (
    config.sensitiveFiles?.rules ?? []
  ).map((path, i) => ({
    id: `user-path-${i + 1}`,
    path,
    reason: `命中用户层自定义保护路径 #${i + 1}`,
  }));
  const sensitiveRules = compileSensitiveRules(
    [...DEFAULT_SENSITIVE_RULES, ...userPathRules],
    home,
  );
  // 放行清单：与保护清单同一匹配语义（字面前缀 / glob）
  const allowedRules: CompiledSensitiveRule[] = compileSensitiveRules(
    (config.sensitiveFiles?.allowedPaths ?? []).map((path, i) => ({
      id: `allowed-${i + 1}`,
      path,
      reason: "用户层放行路径",
    })),
    home,
  );
  return {
    enabled: config.enabled ?? true,
    home,
    commandBlacklist: {
      enabled: config.commandBlacklist?.enabled ?? true,
      rules: commandRules,
      allowPatterns: compileAllowPatterns(
        config.commandBlacklist?.allowPatterns ?? [],
      ),
    },
    sensitiveFiles: {
      enabled: config.sensitiveFiles?.enabled ?? true,
      rules: sensitiveRules,
      allowedPaths: allowedRules,
    },
  };
}

/** 核心引擎：纯判定，不做任何宿主 I/O（可独立单测）。 */
export class GuardEngine {
  #cfg: ResolvedConfig;

  constructor(config: SecurityGuardConfig = {}) {
    this.#cfg = resolveGuardConfig(config);
  }

  /**
   * 检查一次工具调用。
   * 返回 null = 放行；返回字符串 = deny 回执（含原因 + 放行方式）。
   * 检查顺序：命令黑名单层 → 敏感文件层（两层独立、独立放行）。
   */
  inspect(toolName: string, rawArguments: unknown): string | null {
    const cfg = this.#cfg;
    if (!cfg.enabled) return null;
    const args = asStringRecord(rawArguments);
    let commandText: string | undefined;
    const paths: string[] = [];
    if (SHELL_TOOLS.has(toolName)) {
      // shell 工具：命令文本过黑名单层；文本中的路径 + workdir 过敏感文件层
      commandText = firstString(args, ["command", "script"]);
      if (commandText !== undefined) {
        paths.push(...extractCommandPaths(commandText));
      }
      const workdir = firstString(args, ["workdir"]);
      if (workdir !== undefined) paths.push(workdir);
    } else if (RUN_CODE_TOOLS.has(toolName)) {
      // run_code：代码文本整体过黑名单层（其子分发工具调用会再走一遍管线）
      commandText = firstString(args, ["code", "program"]);
    } else if (FILE_TOOLS.has(toolName)) {
      // 内置文件工具：路径参数过敏感文件层
      for (const key of FILE_PATH_KEYS) {
        const v = args[key];
        if (typeof v === "string" && v.length > 0) paths.push(v);
      }
    } else {
      // 未知工具：不拦
      return null;
    }
    // 命令黑名单层（allowPatterns 仅放开本层）
    if (commandText !== undefined && cfg.commandBlacklist.enabled) {
      if (!isCommandAllowed(commandText, cfg.commandBlacklist.allowPatterns)) {
        const hit = matchCommand(commandText, cfg.commandBlacklist.rules);
        if (hit !== null) return formatCommandReceipt(hit);
      }
    }
    // 敏感文件层（allowedPaths 仅放开本层）
    if (cfg.sensitiveFiles.enabled) {
      for (const raw of paths) {
        const norm = normalizePath(raw, cfg.home);
        if (cfg.sensitiveFiles.allowedPaths.some((r) => r.matchPath(norm)))
          continue;
        const hit = checkSensitivePath(raw, cfg.sensitiveFiles.rules, cfg.home);
        if (hit !== null) {
          return formatSensitiveReceipt(hit, toolName, toolOperation(toolName));
        }
      }
    }
    return null;
  }
}

/** 创建守卫并挂到宿主 tools/pre-execute 水位线；返回引擎与 disposer。 */
export function createSecurityGuard(
  host: GuardHost,
  config: SecurityGuardConfig = {},
): { guard: GuardEngine; dispose: () => void } {
  const guard = new GuardEngine(config);
  const detach = host.on("tools/pre-execute", (exec, next) => {
    const receipt = guard.inspect(exec.name, exec.arguments);
    if (receipt !== null) {
      // 一行日志（首行即规则命中摘要），完整回执在工具结果文本里
      const firstLine = receipt.split("\n")[0] ?? receipt;
      host
        .logger?.(name)
        .info(`security-guard blocked tool=${exec.name}: ${firstLine}`);
      return { kind: "deny", reason: receipt };
    }
    return next();
  });
  host
    .logger?.(name)
    .info("security-guard mounted: tools/pre-execute（黑名单 + 敏感文件保护）");
  return {
    guard,
    dispose: typeof detach === "function" ? () => void detach() : () => {},
  };
}

/** bundle 入口：宿主加载后调用一次（监听器随宿主 fiber 生命周期回收）。 */
export function apply(ctx: GuardHost, config: SecurityGuardConfig = {}): void {
  createSecurityGuard(ctx, config);
}
