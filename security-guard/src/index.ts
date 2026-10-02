/**
 * security-guard 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / inject / provide / apply，Config 以类型别名给出（无运行时 schema，宿主不校验，
 * 配置原样透传给 apply；缺省/非法值沿用本包既有语义——非法规则按保守策略处理，不新增校验）。
 * @deepseek-ai/cordis 是 dsh 仓的 workspace 包（未发布 npm），故宿主 ctx 以
 * 结构化类型声明（与 knowledge-base 同策略）；GuardEngine 是核心（纯、可测），
 * apply 是宿主挂载入口。
 *
 * 拦截点：宿主 `tools/pre-execute` waterfall（命令下发前，见 dsh
 * packages/core/tools）。命中即返回 { kind: 'deny', reason: <回执> }，
 * 宿主将工具调用物化为带错误文本的 isError 结果、不下发命令。
 * 回执含拦截原因 + 放行方式（用户层配置 allowPatterns / allowedPaths）。
 *
 * 另有一条**执行前复查**入口：`GuardEngine.inspectCommand(command, source)`（并挂到服务面
 * `guard`，供插件经 `ctx.get('guard')` 调用）——给「命令不在工具入参里」的场景补同口径复查
 * （如 metric-loop 的 `tick` 执行状态文件里的 `spec.measureCmd`）。
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
/** 只读查询面挂载声明（BACKLOG C3 补全：TUI /guard 经 ctx.get('guard') 接线） */
export const provide = ["guard"];

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

/**
 * Config 契约别名（DSH bundle §0 的 `Config`）：仅类型级导出，不新增运行时 schema——
 * cordis `resolveConfig()` 只在本导出带 `'~standard'` 校验接口时才校验配置，无 schema 即
 * 原样透传，故不改变本包既有的缺省归一化/非法规则保守处理语义（避免 fail-closed 改变行为）。
 */
export type Config = SecurityGuardConfig;

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

/**
 * 拦截面：shell 工具 → command 文本；run_code → code 文本；文件工具 → 路径参数；
 * 插件文件工具 → 登记路径参数；插件命令工具 → 登记命令参数（见 PLUGIN_COMMAND_TOOLS）。
 */
const SHELL_TOOLS = new Set(["bash", "shell", "pwsh"]);
const RUN_CODE_TOOLS = new Set(["run_code"]);
// read_image 是官方读面工具（参数 file_path），与 read 同级：只过敏感文件层读侧
const FILE_TOOLS = new Set([
  "read",
  "read_image",
  "write",
  "edit",
  "patch",
  "grep",
  "glob",
]);
const FILE_PATH_KEYS = ["file_path", "path", "target", "file"] as const;
const WRITE_FILE_TOOLS = new Set(["write", "edit", "patch"]);

/** 插件文件工具描述符：登记本仓插件工具的读写面与路径参数名。 */
interface PluginFileTool {
  /** 工具默认操作面；read-write 表示读写面随 action 变化（配合 writeWhen）。 */
  operation: "read" | "write" | "read-write";
  /** 单值路径参数名（取 string 值）。 */
  pathKeys: readonly string[];
  /** 多值路径参数名（数组中取 string 元素）。 */
  pathArrayKeys?: readonly string[];
  /** 写面判定（如 md_logic 仅 action=replace 写）；缺省按 operation。 */
  writeWhen?: (args: Record<string, unknown>) => boolean;
}

/**
 * 插件文件工具登记表：登记会读写文件的插件工具——
 * 写面：hash_edit（整文件重写）、md_logic（action=replace）、ast_replace（单文件写回，
 * 参数面只有 path）；
 * 读面（与官方 read / grep / glob 同口径）：ast_query（path / paths）、hash_read（path）、
 * fs_digest（path）、code_map（root，缺省 cwd）、md_map（root / path）。
 * 未登记的工具仍走「未知工具不拦」的既有边界（见 README「边界与限制」）。
 */
const PLUGIN_FILE_TOOLS: Record<string, PluginFileTool> = {
  hash_edit: { operation: "write", pathKeys: ["path"] },
  md_logic: {
    operation: "read-write",
    pathKeys: ["path"],
    writeWhen: (args) => args.action === "replace",
  },
  ast_replace: { operation: "write", pathKeys: ["path"] },
  ast_query: {
    operation: "read",
    pathKeys: ["path"],
    pathArrayKeys: ["paths"],
  },
  // 读面登记（读工具返回文件内容/结构，此前不过敏感文件层，与官方 read/grep 不对称）
  hash_read: { operation: "read", pathKeys: ["path"] },
  fs_digest: { operation: "read", pathKeys: ["path"] },
  code_map: { operation: "read", pathKeys: ["root"] },
  md_map: { operation: "read", pathKeys: ["root", "path"] },
};

/**
 * 登记表查表：按自身属性判定（Object.hasOwn）。
 * 工具名可能是 constructor / toString / valueOf 等原型链属性名，直接下标会命中
 * Object.prototype 上的成员（非本表条目），故未登记一律返回 undefined → 放行不抛。
 */
function pluginFileTool(toolName: string): PluginFileTool | undefined {
  return Object.hasOwn(PLUGIN_FILE_TOOLS, toolName)
    ? PLUGIN_FILE_TOOLS[toolName]
    : undefined;
}

/** 插件命令工具描述符：登记入参里带 shell 命令文本的插件工具。 */
interface PluginCommandTool {
  /** 顶层命令参数名（取 string 值），如 metric_loop 的 measureCmd。 */
  commandKeys?: readonly string[];
  /**
   * 嵌套命令路径（点号分隔；段名带 `[]` 表示该值是数组、逐元素展开），
   * 如 `children[].executor.command`。
   */
  commandPaths?: readonly string[];
}

/**
 * 插件命令工具登记表：登记会把**模型给的命令串**交给系统 shell 执行的插件工具
 * （实现时按各包读码核实的真实参数面登记）：
 * - `metric_loop`：`measureCmd`（action=start 时经 /bin/sh -c 执行，见 metric-loop/src/measure.ts）；
 * - `task_decompose`：`children[].executor.command`（command 后端的执行命令）与
 *   `children[].acceptance[].command`（mechanical 验收命令）——两者都由模型在本工具写进
 *   帧契约，执行发生在 `task_execute` / `task_stop`（那两个工具的入参只有 task_id，
 *   不含命令文本），故检查点落在声明处（残留边界见 README「边界与限制」）。
 * 未登记的工具仍走「未知工具不拦」的既有边界（见 README「边界与限制」）。
 */
const PLUGIN_COMMAND_TOOLS: Record<string, PluginCommandTool> = {
  metric_loop: { commandKeys: ["measureCmd"] },
  task_decompose: {
    commandPaths: [
      "children[].executor.command",
      "children[].acceptance[].command",
    ],
  },
};

/** 命令工具登记表查表（与文件表同口径：Object.hasOwn，原型链属性名视同未登记）。 */
function pluginCommandTool(toolName: string): PluginCommandTool | undefined {
  return Object.hasOwn(PLUGIN_COMMAND_TOOLS, toolName)
    ? PLUGIN_COMMAND_TOOLS[toolName]
    : undefined;
}

/**
 * 按点号路径取嵌套命令文本：逐段取对象键值；段名带 `[]` 时把该值按数组逐元素展开
 * （非数组不做隐式包装，缺键即空）。只收非空 string，其余类型忽略。
 */
function commandPathValues(
  args: Record<string, unknown>,
  path: string,
): string[] {
  let nodes: unknown[] = [args];
  for (const segment of path.split(".")) {
    const isArray = segment.endsWith("[]");
    const key = isArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const node of nodes) {
      const value = asStringRecord(node)[key];
      if (value === undefined) continue;
      if (isArray) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    nodes = next;
  }
  return nodes.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/** 插件命令工具的命令文本提取：顶层 commandKeys + 嵌套 commandPaths（各带来源参数路径）。 */
function pluginCommands(
  args: Record<string, unknown>,
  tool: PluginCommandTool,
): { keyPath: string; text: string }[] {
  const out: { keyPath: string; text: string }[] = [];
  for (const key of tool.commandKeys ?? []) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) {
      out.push({ keyPath: key, text: v });
    }
  }
  for (const path of tool.commandPaths ?? []) {
    for (const text of commandPathValues(args, path)) {
      out.push({ keyPath: path, text });
    }
  }
  return out;
}

/**
 * 插件命令工具的来源标注行：标准命令回执（规则 id / 命令 / 原因 / 放行方式）不变，
 * 仅前置一行来源——模型据此知道被拦的是哪个工具的哪个命令参数。
 */
function formatPluginCommandSource(toolName: string, keyPath: string): string {
  return `[security-guard] 拦截来源：插件命令工具「${toolName}」的命令参数（${keyPath}）。`;
}

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

/** 一次判定的审计记录（recent() 返回，新在前）。 */
export interface GuardRecord {
  /** 被检查的工具名。 */
  toolName: string;
  /** 判定结果：放行 / 拦截。 */
  verdict: "allow" | "deny";
  /** deny 时的完整回执（含原因 + 放行方式）。 */
  reason?: string;
  /** 判定时刻（epoch 毫秒）。 */
  time: number;
}

/** 当前策略/规则快照（policy() 返回，供 TUI /guard 展示）。 */
export interface PolicySnapshot {
  enabled: boolean;
  commandBlacklist: {
    enabled: boolean;
    /** 规则 id + 人话原因（不含正则/谓词实现细节）。 */
    rules: readonly { id: string; reason: string }[];
    /** 放行正则源（按配置顺序）。 */
    allowPatterns: readonly string[];
  };
  sensitiveFiles: {
    enabled: boolean;
    rules: readonly { id: string; reason: string }[];
    allowedPaths: readonly { id: string; reason: string }[];
  };
}

/**
 * guard 服务面（`apply` 里 `provide("guard")` → 宿主 `ctx.get('guard')`）：
 * 只读查询（TUI /guard） + 外部命令复查（插件自查，如 metric-loop 的 tick）。
 */
export interface GuardService {
  /** 最近判定记录（新→旧）。 */
  recent(): readonly GuardRecord[];
  /** 当前策略/规则快照。 */
  policy(): PolicySnapshot;
  /**
   * 复查一条**不在工具入参里**的命令文本（与 shell 工具同口径：命令黑名单层 +
   * 命令内路径的敏感文件层）。返回 null = 放行；字符串 = deny 回执。
   * `source` 标注命令来源（回执首行 + `recent()` 的 toolName）。
   */
  inspectCommand(command: string, source?: string): string | null;
}

/** 记录缓冲上限（有界，超出丢弃最旧）。 */
const MAX_RECORDS = 200;

function asStringRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** 插件工具的路径提取：pathKeys 取 string 值，pathArrayKeys 取数组中的 string 元素。 */
function pluginFilePaths(
  args: Record<string, unknown>,
  tool: PluginFileTool,
): string[] {
  const paths: string[] = [];
  for (const key of tool.pathKeys) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) paths.push(v);
  }
  for (const key of tool.pathArrayKeys ?? []) {
    const v = args[key];
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      if (typeof item === "string" && item.length > 0) paths.push(item);
    }
  }
  return paths;
}

/**
 * 文件工具的敏感文件操作面：命令登记表（命令经 shell 执行，读写两面都可能）→ 插件文件
 * 登记表（writeWhen 为真 → write；read-write 非写 action → read）→ shell 读写两面 →
 * 写类官方工具 write → 其余 read。官方工具语义不变。
 */
function toolOperation(
  toolName: string,
  args: Record<string, unknown>,
): "read" | "write" | "read-write" {
  if (pluginCommandTool(toolName) !== undefined) return "read-write";
  const plugin = pluginFileTool(toolName);
  if (plugin !== undefined) {
    if (plugin.writeWhen?.(args) === true) return "write";
    if (plugin.operation === "read-write") return "read";
    return plugin.operation;
  }
  if (SHELL_TOOLS.has(toolName)) return "read-write";
  if (WRITE_FILE_TOOLS.has(toolName)) return "write";
  return "read";
}

/** 回执里展示的工具名：读写面随 action 变的插件工具补上 action（如「md_logic replace」）。 */
function receiptToolName(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const plugin = pluginFileTool(toolName);
  if (plugin?.writeWhen === undefined) return toolName;
  const action = args.action;
  return typeof action === "string" && action.length > 0
    ? `${toolName} ${action}`
    : toolName;
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
  #records: GuardRecord[] = [];

  constructor(config: SecurityGuardConfig = {}) {
    this.#cfg = resolveGuardConfig(config);
  }

  /**
   * 检查一次工具调用。
   * 返回 null = 放行；返回字符串 = deny 回执（含原因 + 放行方式）。
   * 检查顺序：命令黑名单层 → 敏感文件层（两层独立、独立放行）。
   * 每次判定都会记入缓冲（recent() 可查），不改变判定逻辑与返回值。
   */
  inspect(toolName: string, rawArguments: unknown): string | null {
    const receipt = this.#decide(toolName, rawArguments);
    this.#record(toolName, receipt);
    return receipt;
  }

  /** 最近判定记录（新→旧），返回副本，外部修改不影响内部缓冲。 */
  recent(): readonly GuardRecord[] {
    return [...this.#records].reverse();
  }

  /** 当前策略/规则快照（enabled、规则 id+原因、放行正则源）。 */
  policy(): PolicySnapshot {
    const cfg = this.#cfg;
    return {
      enabled: cfg.enabled,
      commandBlacklist: {
        enabled: cfg.commandBlacklist.enabled,
        rules: cfg.commandBlacklist.rules.map((r) => ({
          id: r.id,
          reason: r.reason,
        })),
        allowPatterns: cfg.commandBlacklist.allowPatterns.map(
          (re) => re.source,
        ),
      },
      sensitiveFiles: {
        enabled: cfg.sensitiveFiles.enabled,
        rules: cfg.sensitiveFiles.rules.map((r) => ({
          id: r.id,
          reason: r.reason,
        })),
        allowedPaths: cfg.sensitiveFiles.allowedPaths.map((r) => ({
          id: r.id,
          reason: r.reason,
        })),
      },
    };
  }

  #record(toolName: string, receipt: string | null): void {
    this.#records.push({
      toolName,
      verdict: receipt === null ? "allow" : "deny",
      ...(receipt !== null ? { reason: receipt } : {}),
      time: Date.now(),
    });
    // ponytail: 单数组先进先出上限缓冲；需要按工具/时间筛选时再升级
    if (this.#records.length > MAX_RECORDS) this.#records.shift();
  }

  #decide(toolName: string, rawArguments: unknown): string | null {
    const cfg = this.#cfg;
    if (!cfg.enabled) return null;
    const args = asStringRecord(rawArguments);
    // 待过命令黑名单层的命令文本（sourceLine = 插件命令工具的来源标注行）
    const commands: { text: string; sourceLine?: string }[] = [];
    const paths: string[] = [];
    if (SHELL_TOOLS.has(toolName)) {
      // shell 工具：命令文本过黑名单层；文本中的路径 + workdir 过敏感文件层
      const commandText = firstString(args, ["command", "script"]);
      if (commandText !== undefined) {
        commands.push({ text: commandText });
        paths.push(...extractCommandPaths(commandText));
      }
      const workdir = firstString(args, ["workdir"]);
      if (workdir !== undefined) paths.push(workdir);
    } else if (RUN_CODE_TOOLS.has(toolName)) {
      // run_code：代码文本整体过黑名单层（其子分发工具调用会再走一遍管线）
      const codeText = firstString(args, ["code", "program"]);
      if (codeText !== undefined) commands.push({ text: codeText });
    } else if (FILE_TOOLS.has(toolName)) {
      // 内置文件工具：路径参数过敏感文件层
      for (const key of FILE_PATH_KEYS) {
        const v = args[key];
        if (typeof v === "string" && v.length > 0) paths.push(v);
      }
    } else {
      const plugin = pluginFileTool(toolName);
      const commandTool = pluginCommandTool(toolName);
      // 未登记工具：不拦（已知边界，见 README「边界与限制」）
      if (plugin === undefined && commandTool === undefined) return null;
      // 插件文件工具（登记表）：按各自 pathKeys / pathArrayKeys 提取路径，
      // 与官方文件工具同一路径解析与敏感文件层口径
      if (plugin !== undefined) paths.push(...pluginFilePaths(args, plugin));
      // 插件命令工具（登记表）：按 commandKeys / commandPaths 提取命令文本，
      // 与 shell 工具同一命令黑名单层 + 路径抽取口径（同登记文件表时两套都走，互不覆盖）
      if (commandTool !== undefined) {
        for (const c of pluginCommands(args, commandTool)) {
          commands.push({
            text: c.text,
            sourceLine: formatPluginCommandSource(toolName, c.keyPath),
          });
          paths.push(...extractCommandPaths(c.text));
        }
      }
    }
    return this.#decideCollected(toolName, args, commands, paths);
  }

  /**
   * 复查一条**不在工具入参里**的命令文本——给「命令来自状态文件 / 契约」这类旁路补执行前检查点
   * （调用方：metric-loop 的 tick 执行 `spec.measureCmd` 前）。与 shell 工具同一口径：
   * 命令黑名单层 + 命令内路径的敏感文件层（`allowPatterns` / `allowedPaths` 同样生效），
   * 判定同样记入 `recent()`（toolName = `source`，TUI /guard 可审计）。
   * 返回 null = 放行；字符串 = deny 回执（首行为来源标注）。
   */
  inspectCommand(command: string, source = "external-command"): string | null {
    // 防御：服务面经跨包结构调用，非字符串按「无命令」处理（类型由调用方保证）
    if (typeof command !== "string") return null;
    const label =
      typeof source === "string" && source.length > 0
        ? source
        : "external-command";
    const receipt = this.#decideCollected(
      label,
      { command },
      [
        {
          text: command,
          sourceLine: `[security-guard] 命令复查来源：${label}。`,
        },
      ],
      extractCommandPaths(command),
      // 命令面读写都可能（与 shell 工具同款措辞），避免误标成「读取」
      "read-write",
    );
    this.#record(label, receipt);
    return receipt;
  }

  /**
   * 「命令文本 + 路径」收集完成后的最终判定：命令黑名单层 → 敏感文件层（两层独立、独立放行）。
   * 官方 shell 工具、插件命令工具与 `inspectCommand`（外部命令复查）共用同一口径；
   * `operation` 缺省按工具/参数推导（命令面为 read-write），供外部复查标注操作面。
   */
  #decideCollected(
    toolName: string,
    args: Record<string, unknown>,
    commands: readonly { text: string; sourceLine?: string }[],
    paths: readonly string[],
    operation?: "read" | "write" | "read-write",
  ): string | null {
    const cfg = this.#cfg;
    if (!cfg.enabled) return null;
    // 命令黑名单层（allowPatterns 仅放开本层）：逐条命令文本同一口径判定
    if (cfg.commandBlacklist.enabled) {
      for (const c of commands) {
        if (isCommandAllowed(c.text, cfg.commandBlacklist.allowPatterns)) {
          continue;
        }
        const hit = matchCommand(c.text, cfg.commandBlacklist.rules);
        if (hit !== null) {
          const receipt = formatCommandReceipt(hit);
          return c.sourceLine === undefined
            ? receipt
            : `${c.sourceLine}\n${receipt}`;
        }
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
          return formatSensitiveReceipt(
            hit,
            receiptToolName(toolName, args),
            operation ?? toolOperation(toolName, args),
          );
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
