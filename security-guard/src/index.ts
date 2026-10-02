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
 * 未登记工具（不在显式白名单内的工具）由 `unknownToolPolicy` 三态控制：`"allow"`（缺省，一律放行）/
 * `"check"`（把 watched 键下的字符串值按键类定向派发到既有两层，命中才拦） / `"deny"`（整工具拦）；
 * `unknownToolAllowlist` 在三态之前判定，命中即无条件放行（见 README「未登记工具」）。
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
  /**
   * 未登记工具策略（默认 "allow"）。
   * - `"allow"`：一律放行（历史行为）；
   * - `"check"`：不整工具硬拦，把 watched 键下的字符串值按键类定向过既有两层
   *   （命令键 → 命令黑名单层；路径键与值面绝对路径 → 敏感文件层；代码键
   *   `script` / `code` / `program` 只做路径提取，不整段送命令层），命中才拦；
   * - `"deny"`：整工具拦（仅限「携带潜在路径/命令参数」的未登记工具，键名启发见
   *   unknownToolSensitiveKeys）。
   * 非法值（非以上三值）按 `"allow"` 生效并 `console.warn` 一次，`policy()` 标 `invalid: true`。
   */
  unknownToolPolicy?: "allow" | "check" | "deny";
  /**
   * 未登记工具放行名单（工具名精确匹配；以 `*` 结尾为前缀通配，如 `mcp__*`）。
   * 在三态策略**之前**判定：命中即无条件放行（`deny` 下的显式例外 / MCP 工具名）。
   */
  unknownToolAllowlist?: readonly string[];
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

/**
 * 未登记工具的路径参数键名（**键集单一来源**：本包唯一一份，`scripts/tool-surface-check.mjs`
 * 经 `TOOL_SURFACE` 复用，脚本与引擎不再各维护一套）。
 * 键名按**小写归一**比较（`filePath` → `filepath`、`measureCmd` → `measurecmd`）。
 */
export const UNKNOWN_TOOL_PATH_KEYS = [
  "file_path",
  "path",
  "target",
  "file",
  "paths",
  "dir",
  "directory",
  "root",
  "workdir",
  "cwd",
  "filepath",
] as const;
/** 未登记工具的命令参数键名（**命令键**：值是 shell 命令串，整段过命令黑名单层）。 */
export const UNKNOWN_TOOL_COMMAND_KEYS = [
  "command",
  "measurecmd",
  "cmd",
] as const;
/**
 * 未登记工具的**代码键**（`script` / `code` / `program` 的值是 JS/Python 代码，不是 shell 命令串）：
 * `check` 模式只做**路径类提取**（把其中出现的路径 token 送敏感文件层），**不整段送命令黑名单层**
 * —— 代码文本里出现提权词 / 危险序列字面（如字符串里的 `"sudo"`）不算执行该命令，整段匹配会误拦。
 */
export const UNKNOWN_TOOL_CODE_KEYS = ["script", "code", "program"] as const;

/**
 * 路径键集 / 命令键集 / 代码键集 / watched 键集（小写归一；
 * deny 的键名启发与 check 的语义派发共用，三类键都属 watched）。
 */
const UNKNOWN_TOOL_PATH_KEY_SET: ReadonlySet<string> = new Set(
  UNKNOWN_TOOL_PATH_KEYS,
);
const UNKNOWN_TOOL_COMMAND_KEY_SET: ReadonlySet<string> = new Set(
  UNKNOWN_TOOL_COMMAND_KEYS,
);
const UNKNOWN_TOOL_CODE_KEY_SET: ReadonlySet<string> = new Set(
  UNKNOWN_TOOL_CODE_KEYS,
);
const UNKNOWN_TOOL_WATCHED: ReadonlySet<string> = new Set<string>([
  ...UNKNOWN_TOOL_PATH_KEYS,
  ...UNKNOWN_TOOL_COMMAND_KEYS,
  ...UNKNOWN_TOOL_CODE_KEYS,
]);

/**
 * 工具覆盖面快照：给 `scripts/tool-surface-check.mjs` 复用的**机器可读单一来源**
 * （已登记工具名 + 三类 watched 键集）。登记表本身仍是本文件内的常量，此处只是只读快照。
 */
export const TOOL_SURFACE = {
  /** 已登记的工具名（官方 shell / run_code / 文件工具 + 两张插件登记表）。 */
  registered: [
    ...SHELL_TOOLS,
    ...RUN_CODE_TOOLS,
    ...FILE_TOOLS,
    ...Object.keys(PLUGIN_FILE_TOOLS),
    ...Object.keys(PLUGIN_COMMAND_TOOLS),
  ].sort(),
  /** 未登记工具的路径键（小写归一）。 */
  pathKeys: UNKNOWN_TOOL_PATH_KEYS,
  /** 未登记工具的命令键（小写归一，值是 shell 命令串）。 */
  commandKeys: UNKNOWN_TOOL_COMMAND_KEYS,
  /** 未登记工具的代码键（小写归一，值是代码文本，check 模式只做路径提取）。 */
  codeKeys: UNKNOWN_TOOL_CODE_KEYS,
} as const;

/** 键名归一：小写比较（`filePath` → `filepath`、`measureCmd` → `measurecmd`）。 */
function normalizeKeyName(key: string): string {
  return key.toLowerCase();
}

/** watched 键命中的面：路径键 / 命令键 / 代码键 / 非 watched 键。 */
function watchedKeyKind(key: string): "path" | "command" | "code" | null {
  const lower = normalizeKeyName(key);
  if (UNKNOWN_TOOL_PATH_KEY_SET.has(lower)) return "path";
  if (UNKNOWN_TOOL_COMMAND_KEY_SET.has(lower)) return "command";
  return UNKNOWN_TOOL_CODE_KEY_SET.has(lower) ? "code" : null;
}

/** 未登记工具是否携带潜在路径/命令参数：返回命中的键名（原样、去重、保序）。 */
function unknownToolSensitiveKeys(args: Record<string, unknown>): string[] {
  const hits: string[] = [];
  const consider = (key: string): void => {
    if (watchedKeyKind(key) !== null && !hits.includes(key)) hits.push(key);
  };
  for (const [key, value] of Object.entries(args)) {
    consider(key);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          for (const inner of Object.keys(item)) consider(inner);
        }
      }
    } else if (value !== null && typeof value === "object") {
      for (const inner of Object.keys(value)) consider(inner);
    }
  }
  return hits;
}

/** 未登记工具拦截回执（unknownToolPolicy="deny"）：放行方式给配置级可行动作，不再只说「改源码」。 */
function formatUnknownToolReceipt(toolName: string, keys: string[]): string {
  return [
    `[security-guard] 已拦截：未登记工具「${toolName}」携带潜在路径/命令参数（${keys.join(" / ")}）。`,
    "原因：该工具不在 security-guard 的登记表内，无法确认其路径/命令是否经过敏感文件层与命令黑名单层。",
    "放行方式（三选一）：",
    '  ① 配 unknownToolPolicy: "check"：放行安全值，仍拦敏感路径 / 危险命令；',
    `  ② 配 unknownToolAllowlist: ["${toolName}"]：该工具整体放行（工具名支持 * 结尾的前缀通配）；`,
    "  ③ 按真实参数面登记进 FILE_TOOLS / PLUGIN_FILE_TOOLS / PLUGIN_COMMAND_TOOLS（改源码，最彻底）。",
  ].join("\n");
}

/**
 * 未登记工具放行名单（编译后）：工具名精确匹配 + `*` 结尾前缀通配。
 * 在策略之前判定（`allow` / `check` / `deny` 三态一致）：命中即无条件放行。
 * `"*"` 等价于放行全部未登记工具（前缀为空串）。
 */
interface UnknownToolAllowlist {
  exact: ReadonlySet<string>;
  prefixes: readonly string[];
}

/** 编译未登记工具放行名单（非字符串 / 空串条目忽略——配置无运行时 schema 校验）。 */
function compileUnknownToolAllowlist(
  list: readonly string[],
): UnknownToolAllowlist {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (name.length === 0) continue;
    if (name.endsWith("*")) prefixes.push(name.slice(0, -1));
    else exact.add(name);
  }
  return { exact, prefixes };
}

/** 未登记工具是否在放行名单内（精确或 `*` 前缀通配）。 */
function unknownToolAllowed(
  toolName: string,
  list: UnknownToolAllowlist,
): boolean {
  return (
    list.exact.has(toolName) ||
    list.prefixes.some((prefix) => toolName.startsWith(prefix))
  );
}

/** check 模式的键面扫描结果（key = 来源参数键名，回执来源标注行用）。 */
interface UnknownToolScan {
  /** 待过命令黑名单层的命令文本。 */
  commands: { text: string; key: string }[];
  /** 待过敏感文件层的路径。 */
  paths: { path: string; key: string }[];
}

/** 取「可作命令/路径文本的值」：非空字符串，或数组里的非空字符串元素。 */
function textValues(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/**
 * 值面路径判定（键名之外的兜底）：`cwd:` 前缀（如 `session_channel.to = "cwd:/path"`）剥掉前缀后
 * 按路径处理；明显绝对路径 / 家目录路径（`/`、`~/`、`$HOME`、`${HOME}` 开头）原样按路径处理；
 * 其余返回 null（不猜测语义）。
 */
function pathLikeValue(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("cwd:")) {
    const rest = trimmed.slice(4).trim();
    return rest.length > 0 ? rest : null;
  }
  return /^(?:\/|~\/|\$HOME|\$\{HOME\})/.test(trimmed) ? trimmed : null;
}

/**
 * 未登记工具的键面 + 值面扫描（`unknownToolPolicy: "check"` 用）：
 * 遍历深度与键名启发一致（顶层键 + 数组元素键 / 嵌套对象一层键），命中 watched 键时把该键下的
 * 字符串值（含数组元素）**按键类定向**：
 * - 路径键 → 直接作路径候选（敏感文件层）；
 * - 命令键 → 作命令文本（命令黑名单层）；
 * - 代码键（`script` / `code` / `program`）→ 只做**路径类提取**（`extractCommandPaths`），
 *   不整段送命令层（代码里的危险词字面不算执行该命令，避免误拦）；
 * - 非 watched 键 → 字符串值再过一次值面判定（`cwd:` 前缀 / 绝对路径）。
 */
function scanUnknownToolArgs(args: Record<string, unknown>): UnknownToolScan {
  const scan: UnknownToolScan = { commands: [], paths: [] };
  const consider = (key: string, value: unknown): void => {
    const kind = watchedKeyKind(key);
    for (const text of textValues(value)) {
      if (kind === "command") scan.commands.push({ text, key });
      else if (kind === "path") scan.paths.push({ path: text, key });
      else if (kind === "code") {
        for (const path of extractCommandPaths(text)) {
          scan.paths.push({ path, key });
        }
      } else {
        const like = pathLikeValue(text);
        if (like !== null) scan.paths.push({ path: like, key });
      }
    }
  };
  for (const [key, value] of Object.entries(args)) {
    consider(key, value);
    const nested: Record<string, unknown>[] = Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item),
        )
      : value !== null && typeof value === "object"
        ? [value as Record<string, unknown>]
        : [];
    for (const item of nested) {
      for (const [innerKey, innerValue] of Object.entries(item)) {
        consider(innerKey, innerValue);
      }
    }
  }
  return scan;
}

/** check 模式的来源标注行（与 `inspectCommand` / 插件命令工具同风格：标准回执前置一行来源）。 */
function formatUnknownToolCommandSource(toolName: string, key: string): string {
  return `[security-guard] 命令复查来源：未登记工具「${toolName}」的 ${key}。`;
}

/** 路径面来源标注行（同上）。 */
function formatUnknownToolPathSource(toolName: string, key: string): string {
  return `[security-guard] 路径复查来源：未登记工具「${toolName}」的 ${key}。`;
}

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
  /** 未登记工具策略（**生效值**；非法值按 "allow" 生效）。 */
  unknownToolPolicy: "allow" | "check" | "deny";
  /** 配置里的原始值（policy() 展示；非法值原样保留）。 */
  unknownToolPolicyRaw: unknown;
  /** 原始值非法（非 undefined / "allow" / "check" / "deny"）。 */
  unknownToolPolicyInvalid: boolean;
  /** 未登记工具放行名单（原始配置，policy() 展示）。 */
  unknownToolAllowlist: readonly string[];
  /** 未登记工具放行名单（编译后，判定用）。 */
  unknownToolAllowlistRules: UnknownToolAllowlist;
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
  /** 未登记工具策略：配置原始值 / 生效值 / 是否非法（非法按 "allow" 生效并告警一次）。 */
  unknownToolPolicy: {
    /** 配置里写的原始值（未归一化；非法值原样展示，如 `true` / `"Deny"`）。 */
    value: unknown;
    /** 实际生效的策略。 */
    effective: "allow" | "check" | "deny";
    /** 原始值非法（非 undefined / 三值之一）→ 已按 "allow" 生效。 */
    invalid: boolean;
  };
  /** 未登记工具放行名单（工具名精确或 `*` 结尾前缀通配）。 */
  unknownToolAllowlist: readonly string[];
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
  // 未登记工具策略：缺省 allow；非法值按 allow 生效（fail-open 语义不变），但告警一次并标 invalid
  const rawPolicy: unknown = config.unknownToolPolicy;
  const policyInvalid =
    rawPolicy !== undefined &&
    rawPolicy !== "allow" &&
    rawPolicy !== "check" &&
    rawPolicy !== "deny";
  if (policyInvalid) {
    console.warn(
      `[security-guard] 非法配置 unknownToolPolicy=${JSON.stringify(rawPolicy)}，已按 "allow" 生效` +
        '（可选值："allow" | "check" | "deny"）；policy() 快照标记 invalid=true。',
    );
  }
  const effectivePolicy: "allow" | "check" | "deny" =
    rawPolicy === "check" || rawPolicy === "deny" ? rawPolicy : "allow";
  const allowlist = [...(config.unknownToolAllowlist ?? [])];
  return {
    unknownToolPolicy: effectivePolicy,
    unknownToolPolicyRaw: rawPolicy,
    unknownToolPolicyInvalid: policyInvalid,
    unknownToolAllowlist: allowlist,
    unknownToolAllowlistRules: compileUnknownToolAllowlist(allowlist),
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

  /** 当前策略/规则快照（enabled、未登记工具策略、规则 id+原因、放行正则源）。 */
  policy(): PolicySnapshot {
    const cfg = this.#cfg;
    return {
      enabled: cfg.enabled,
      unknownToolPolicy: {
        value: cfg.unknownToolPolicyRaw,
        effective: cfg.unknownToolPolicy,
        invalid: cfg.unknownToolPolicyInvalid,
      },
      unknownToolAllowlist: [...cfg.unknownToolAllowlist],
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
      // 未登记工具：先过放行名单（命中即无条件放行），再按 unknownToolPolicy 三态判定
      if (plugin === undefined && commandTool === undefined) {
        if (unknownToolAllowed(toolName, cfg.unknownToolAllowlistRules)) {
          return null;
        }
        if (cfg.unknownToolPolicy === "allow") return null;
        if (cfg.unknownToolPolicy === "deny") {
          // deny：整工具拦「携带潜在路径/命令参数」的未登记工具（键名启发：
          // 顶层 + 数组元素/嵌套对象一层，键名小写归一）
          const watched = unknownToolSensitiveKeys(args);
          return watched.length === 0
            ? null
            : formatUnknownToolReceipt(toolName, watched);
        }
        // check：不整工具硬拦，把 watched 键下的字符串值按语义派发到既有两层
        return this.#checkUnknownTool(toolName, args);
      }
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
   * `unknownToolPolicy: "check"`：未登记工具**不整工具硬拦**——把携带的 watched 键下的字符串值
   * （含数组元素）**按键类定向**派发：命令键（`command` / `measureCmd` / `cmd`）→ 命令黑名单层
   * （`commandBlacklist.allowPatterns` 可放行）；路径键与值面绝对路径（`cwd:` 前缀 / `/`、`~/`）→
   * 敏感文件层（`sensitiveFiles.allowedPaths` 可放行）；代码键（`script` / `code` / `program`）只做
   * 路径提取后过敏感文件层、**不整段送命令层**。命中才拦（标准回执前置一行来源标注），否则放行。
   */
  #checkUnknownTool(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    const scan = scanUnknownToolArgs(args);
    if (scan.commands.length === 0 && scan.paths.length === 0) return null;
    return this.#decideCollected(
      toolName,
      args,
      scan.commands.map((c) => ({
        text: c.text,
        sourceLine: formatUnknownToolCommandSource(toolName, c.key),
      })),
      scan.paths.map((p) => ({
        path: p.path,
        sourceLine: formatUnknownToolPathSource(toolName, p.key),
      })),
      // 未登记工具的操作面未知：敏感层按读写两面标注（与 shell 命令同款措辞）
      "read-write",
    );
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
   * 官方 shell 工具、插件命令工具、`check` 模式的未登记工具与 `inspectCommand`（外部命令复查）
   * 共用同一口径；`sourceLine` 非空时前置一行来源标注（回执首行）；
   * `operation` 缺省按工具/参数推导（命令面为 read-write），供外部复查标注操作面。
   */
  #decideCollected(
    toolName: string,
    args: Record<string, unknown>,
    commands: readonly { text: string; sourceLine?: string }[],
    paths: readonly (string | { path: string; sourceLine?: string })[],
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
      for (const entry of paths) {
        const candidate = typeof entry === "string" ? { path: entry } : entry;
        const norm = normalizePath(candidate.path, cfg.home);
        if (cfg.sensitiveFiles.allowedPaths.some((r) => r.matchPath(norm)))
          continue;
        const hit = checkSensitivePath(
          candidate.path,
          cfg.sensitiveFiles.rules,
          cfg.home,
        );
        if (hit !== null) {
          const receipt = formatSensitiveReceipt(
            hit,
            receiptToolName(toolName, args),
            operation ?? toolOperation(toolName, args),
          );
          return candidate.sourceLine === undefined
            ? receipt
            : `${candidate.sourceLine}\n${receipt}`;
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
      // 日志取回执**前两行**（插件命令工具的首行是来源标注行，规则摘要紧随其后；
      // 只取首行会让日志丢掉规则 id），完整回执在工具结果文本里
      const logHead = receipt.split("\n").slice(0, 2).join(" ");
      host
        .logger?.(name)
        .info(`security-guard blocked tool=${exec.name}: ${logHead}`);
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
