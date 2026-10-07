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
/** 只读查询面挂载声明（TUI `/guard` 经 `ctx.get('guard')` 接线，服务面接口见 GuardService）。 */
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
  /**
   * 单调守卫注册面（宿主 `ctx.tools.guard`，同步判定、返回字符串即拒绝）；
   * 缺省 = 宿主不支持该面 → 回退 `tools/pre-execute` 监听器（见 `createSecurityGuard`）。
   */
  tools?: {
    guard(check: (exec: PreExecuteExecution) => string | undefined): unknown;
  };
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
 * 键名启发 / check 值面扫描的**键深上限**（**单一来源**：`TOOL_SURFACE.keyDepth` 供
 * `scripts/tool-surface-check.mjs` 复用，脚本与引擎不各维护一份）。
 * **3 层**：顶层 → 数组元素 → 其对象成员 → 再一层数组元素 —— **数组透明、不消费键深**
 * （数组元素对象与数组自身同键深）；更深处的同形嵌套不再纳入（**语义**上限，避免深层误伤）。
 * 命中的键以**完整键路径**表示（`children[].acceptance[].command`，与登记表 `commandPaths` 同形）。
 */
const UNKNOWN_TOOL_KEY_DEPTH = 3;

/**
 * 工具覆盖面快照：给 `scripts/tool-surface-check.mjs` 复用的**机器可读单一来源**
 * （已登记工具名 + 三类 watched 键集 + 键深上限）。登记表本身仍是本文件内的常量，
 * 此处只是只读快照。
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
  /** 未登记工具的**键深上限**（数组透明、不消费键深；脚本的参数发现深度与本字段同源）。 */
  keyDepth: UNKNOWN_TOOL_KEY_DEPTH,
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

/**
 * 遍历**容器节点**上限（对象 / 数组各算 1 个节点，**标量不计**）。
 * 与语义上限 `UNKNOWN_TOOL_KEY_DEPTH` 分工：键深锁**语义**（3 层），节点数锁**工作量**。
 * 上限取**节点级**量级：真实工具参数面远小于它；「无害填充 + 更深处危险键」的规避得先填到
 * 4096 个容器才会触发截断，而**截断本身按保守口径拦截**（见 `UnknownToolWalk.truncated`）——
 * 故既不会被打爆，也不会被填充绕过。
 */
const MAX_WALK_NODES = 4096;

/**
 * 遍历**嵌套深度**上限（容器层数）。数组透明不消费**键深**，但深数组照样加深**递归栈**：
 * 实测本遍历器约 3500 层即 `RangeError`，故单列一条栈深上限（64 层远超任何真实参数面）。
 */
const MAX_WALK_DEPTH = 64;

/** 遍历结果：是否被资源上限（`MAX_WALK_NODES` / `MAX_WALK_DEPTH`）截断。 */
interface UnknownToolWalk {
  /** 截断 ⇒ 调用方**必须保守处理**（deny 直接拦 / check 告警 + 拦），绝不能当成「没查到 = 放行」。 */
  truncated: boolean;
}

/**
 * 深度优先遍历参数结构，对每个「对象层」的键调用 `visit(key, keyPath, value)`：
 * `key` 是键名原样（判键类用），`keyPath` 是该键的**完整键路径**（回执用，判键类不看它）——
 * 对象键接 `.name`、数组元素接 `[]`，与插件命令登记表的 `commandPaths` 同形
 * （如 `children[].acceptance[].command`）；顶层键的路径就是键名本身。
 * - 数组透明：数组元素在数组自身那一层继续下钻（故 `files[].path` 的 `path` 与 `files` 同键深）；
 *   数组层照常**计节点**（只是不吃键深）；
 * - 标量：不计节点、不占栈（其键值已由所在对象层的 `visit` 看过）；
 * - 环引用经 `WeakSet` 跳过（自引用 / 共享引用都保证终止）；
 * - 资源上限耗尽即**停止下探**并置 `truncated = true`（不抛错；「还有没查的」交由调用方保守处置）。
 */
function walkUnknownToolArgs(
  args: Record<string, unknown>,
  visit: (key: string, keyPath: string, value: unknown) => void,
): UnknownToolWalk {
  const seen = new WeakSet<object>();
  let nodes = MAX_WALK_NODES;
  let truncated = false;
  // prefix = 当前容器的键路径（`undefined` 表示根，区别于空键名 `""` 的路径前缀）
  const walk = (
    value: unknown,
    keyDepth: number,
    depth: number,
    prefix: string | undefined,
  ): void => {
    if (keyDepth > UNKNOWN_TOOL_KEY_DEPTH) return;
    if (value === null || typeof value !== "object") return;
    if (depth > MAX_WALK_DEPTH || nodes <= 0) {
      truncated = true;
      return;
    }
    nodes -= 1;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      // 数组元素：路径接 `[]`（数组透明，不消费键深）
      const itemPrefix = `${prefix ?? ""}[]`;
      for (const item of value) walk(item, keyDepth, depth + 1, itemPrefix);
      return;
    }
    for (const [key, inner] of Object.entries(value)) {
      const keyPath = prefix === undefined ? key : `${prefix}.${key}`;
      visit(key, keyPath, inner);
      walk(inner, keyDepth + 1, depth + 1, keyPath);
    }
  };
  walk(args, 1, 1, undefined);
  return { truncated };
}

/** 键名启发结果：命中**键路径**（原样、去重、保序）+ 是否被资源上限截断。 */
interface UnknownToolKeyScan {
  paths: string[];
  truncated: boolean;
}

/** 未登记工具是否携带潜在路径/命令参数：返回命中的键路径（去重、保序）与截断标记。 */
function unknownToolSensitiveKeys(
  args: Record<string, unknown>,
): UnknownToolKeyScan {
  const paths: string[] = [];
  const { truncated } = walkUnknownToolArgs(args, (key, keyPath) => {
    if (watchedKeyKind(key) !== null && !paths.includes(keyPath)) {
      paths.push(keyPath);
    }
  });
  return { paths, truncated };
}

/** 回执里最多列出的命中键路径条数：超出部分折叠为「等 N 处」（避免超大参数面把回执撑爆）。 */
const MAX_RECEIPT_KEY_PATHS = 12;

/** 命中键路径列表的字符预算（在条数上限之外再兜一层，防「12 条超长键名」撑爆回执）。 */
const MAX_RECEIPT_LIST_CHARS = 240;

/**
 * 命中键路径列表的展示形态：最多 `MAX_RECEIPT_KEY_PATHS` 条，超出折叠为「等 N 处」。
 * 不改变判定（仅文案上限）；≤ 上限时与旧版逐字一致。
 */
function formatKeyPathList(keyPaths: readonly string[]): string {
  // 先按条数截断，再按字符预算收敛（两条上限取更严者），被折叠的条数写进「等 N 处」
  const kept: string[] = [];
  let budget = MAX_RECEIPT_LIST_CHARS;
  for (const path of keyPaths.slice(0, MAX_RECEIPT_KEY_PATHS)) {
    if (kept.length > 0 && budget - path.length < 0) break;
    kept.push(path);
    budget -= path.length;
  }
  const rest = keyPaths.length - kept.length;
  return rest > 0 ? `${kept.join(" / ")} 等 ${rest} 处` : kept.join(" / ");
}

/**
 * 未登记工具拦截回执（unknownToolPolicy="deny"）：放行方式给配置级可行动作，不再只说「改源码」；
 * 命中参数给**完整键路径**（与登记表 `commandPaths` 同形，如 `children[].acceptance[].command`），
 * 便于定位是哪个嵌套位置的键命中；列表超过 `MAX_RECEIPT_KEY_PATHS` 条时折叠为「等 N 处」。
 */
function formatUnknownToolReceipt(
  toolName: string,
  keyPaths: string[],
): string {
  return [
    `[security-guard] 已拦截：未登记工具「${toolName}」携带潜在路径/命令参数（${formatKeyPathList(keyPaths)}）。`,
    "原因：该工具不在 security-guard 的登记表内，无法确认其路径/命令是否经过敏感文件层与命令黑名单层。",
    "放行方式（三选一）：",
    '  ① 配 unknownToolPolicy: "check"：放行安全值，仍拦敏感路径 / 危险命令；',
    `  ② 配 unknownToolAllowlist: ["${toolName}"]：该工具整体放行（工具名支持 * 结尾的前缀通配）；`,
    "  ③ 按真实参数面登记进 FILE_TOOLS / PLUGIN_FILE_TOOLS / PLUGIN_COMMAND_TOOLS（改源码，最彻底）。",
  ].join("\n");
}

/**
 * 参数面超出遍历资源上限时的拦截回执（deny / check 共用）。
 * 口径：**截断 = 拦**（宁可误拦不可漏拦）——安全策略层只做有界检查，「没查完」不能当成「没查到」。
 */
function formatUnknownToolTruncatedReceipt(
  toolName: string,
  collectedCount = 0,
): string {
  return [
    `[security-guard] 已拦截：未登记工具「${toolName}」的参数面超出遍历上限（${MAX_WALK_NODES} 个容器节点 / ${MAX_WALK_DEPTH} 层嵌套）。`,
    "原因：本层只做有界检查，参数面被截断时无法确认更深处是否藏着敏感路径 / 危险命令，按保守口径拦截。",
    ...(collectedCount > 0
      ? [
          `已收集 ${collectedCount} 项（命令 / 路径）均未命中，但遍历未完成，仍按保守口径拦截。`,
        ]
      : []),
    "放行方式（三选一）：",
    "  ① 缩小参数面：把超大数组 / 深层嵌套拆成多次调用；",
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

/** check 模式的键面扫描结果（keyPath = 来源参数**完整键路径**，回执来源标注行用）。 */
interface UnknownToolScan {
  /** 待过命令黑名单层的命令文本。 */
  commands: { text: string; keyPath: string }[];
  /** 待过敏感文件层的路径。 */
  paths: { path: string; keyPath: string }[];
  /** 遍历是否被资源上限截断（截断 ⇒ check 必须告警 + 拦，绝不能静默放行）。 */
  truncated: boolean;
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
 * 遍历深度与键名启发一致（同一遍历器 `walkUnknownToolArgs`，`UNKNOWN_TOOL_KEY_DEPTH` 上限 3 层：
 * 顶层键 → 数组元素键 → 其对象成员键 → 再一层数组元素键；深度口径不分叉），
 * 命中 watched 键时把该键下的字符串值（含数组元素）**按键类定向**：
 * - 路径键 → 直接作路径候选（敏感文件层）；
 * - 命令键 → 作命令文本（命令黑名单层）；
 * - 代码键（`script` / `code` / `program`）→ 只做**路径类提取**（`extractCommandPaths`），
 *   不整段送命令层（代码里的危险词字面不算执行该命令，避免误拦）；
 * - 非 watched 键 → 字符串值再过一次值面判定（`cwd:` 前缀 / 绝对路径）。
 * 来源标注用**完整键路径**（同一遍历器给出，与登记表 `commandPaths` 同形）。
 * 返回的 `truncated` 由同一遍历器的资源上限给出：截断时调用方**不得**静默放行。
 */
function scanUnknownToolArgs(args: Record<string, unknown>): UnknownToolScan {
  const scan: UnknownToolScan = { commands: [], paths: [], truncated: false };
  const { truncated } = walkUnknownToolArgs(args, (key, keyPath, value) => {
    const kind = watchedKeyKind(key);
    for (const text of textValues(value)) {
      if (kind === "command") scan.commands.push({ text, keyPath });
      else if (kind === "path") scan.paths.push({ path: text, keyPath });
      else if (kind === "code") {
        for (const path of extractCommandPaths(text)) {
          scan.paths.push({ path, keyPath });
        }
      } else {
        const like = pathLikeValue(text);
        if (like !== null) scan.paths.push({ path: like, keyPath });
      }
    }
  });
  scan.truncated = truncated;
  return scan;
}

/** check 模式的来源标注行（与 `inspectCommand` / 插件命令工具同风格：标准回执前置一行来源；键路径与登记表 `commandPaths` 同形）。 */
function formatUnknownToolCommandSource(
  toolName: string,
  keyPath: string,
): string {
  return `[security-guard] 命令复查来源：未登记工具「${toolName}」的 ${keyPath}。`;
}

/** 路径面来源标注行（同上）。 */
function formatUnknownToolPathSource(
  toolName: string,
  keyPath: string,
): string {
  return `[security-guard] 路径复查来源：未登记工具「${toolName}」的 ${keyPath}。`;
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
  /**
   * 工具名**或**来源标注：常规判定记工具名（`bash` / `md_logic replace` …）；
   * 外部命令复查（`inspectCommand(command, source)`）记 `source`（如 `metric_loop{tick} id=x`）。
   */
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
  /**
   * 最近判定记录（新→旧）。记录里的 `toolName` = **工具名或来源标注**
   * （语义见 `GuardRecord.toolName`）：外部命令复查 `inspectCommand` 记的是 `source`，不是工具名。
   */
  recent(): readonly GuardRecord[];
  /**
   * 当前策略/规则快照（开关 / 未登记工具策略 / 规则 id+原因 / 放行正则源）。
   * 这是**策略面**视图，不含逐次判定的工具名/来源标注（那在 `recent()` 里）。
   */
  policy(): PolicySnapshot;
  /**
   * 复查一条**不在工具入参里**的命令文本（与 shell 工具同口径：命令黑名单层 +
   * 命令内路径的敏感文件层）。返回 null = 放行；字符串 = deny 回执。
   * `source` 标注命令来源（回执首行 + 敏感层标签行「来源：<source>」 + `recent()` 的 `toolName`）。
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

/**
 * 回执里的**标签行**（D3）：按标签种类渲染 ——
 * - `"tool"`（真工具调用）→ `工具：<工具名>`（读写面随 action 变的插件工具带 action）；
 * - `"source"`（命令/路径来自工具入参之外，如 `inspectCommand(command, source)` 的 `source`）→
 *   `来源：<来源标注>` —— 不再借「工具：」字段渲染（字段名会误导成工具名）。
 */
function receiptLabelLine(
  toolName: string,
  args: Record<string, unknown>,
  kind: "tool" | "source",
): string {
  return kind === "source"
    ? `来源：${toolName}`
    : `工具：${receiptToolName(toolName, args)}`;
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
  /** 未登记工具的参数扫描失败（畸形参数）是否已告警（只告警一次，避免被刷屏）。 */
  #unknownToolScanWarned = false;
  /** 未登记工具的参数面超出遍历上限（截断 → 保守拦）是否已告警（只告警一次）。 */
  #unknownToolTruncationWarned = false;

  constructor(config: SecurityGuardConfig = {}) {
    this.#cfg = resolveGuardConfig(config);
  }

  /**
   * 检查一次工具调用（判定记入缓冲时 `toolName` 就是**本次工具名**）。
   * 返回 null = 放行；返回字符串 = deny 回执（含原因 + 放行方式）。
   * 检查顺序：命令黑名单层 → 敏感文件层（两层独立、独立放行）。
   * 每次判定都会记入缓冲（recent() 可查），不改变判定逻辑与返回值。
   */
  inspect(toolName: string, rawArguments: unknown): string | null {
    const receipt = this.#decide(toolName, rawArguments);
    this.#record(toolName, receipt);
    return receipt;
  }

  /**
   * 最近判定记录（新→旧），返回副本，外部修改不影响内部缓冲。
   * 记录里的 `toolName` = 工具名**或**来源标注（见 `GuardRecord.toolName`）。
   */
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
        // 未登记工具的键面/值面扫描对**模型给的任意 JSON** 做递归：结构可能畸形（超深数组 / 环 /
        // 枚举即抛错的 Proxy 等）。任何异常一律 fail-open（告警一次 + 按放行处理，与「guard 缺失」
        // 同口径），绝不让 inspect 抛到宿主 listener —— 否则一个畸形参数就能把 pre-execute 打崩。
        try {
          if (unknownToolAllowed(toolName, cfg.unknownToolAllowlistRules)) {
            return null;
          }
          if (cfg.unknownToolPolicy === "allow") return null;
          if (cfg.unknownToolPolicy === "deny") {
            // deny：整工具拦「携带潜在路径/命令参数」的未登记工具（键名启发：
            // walkUnknownToolArgs 深度递归出**完整键路径**，键深上限 UNKNOWN_TOOL_KEY_DEPTH = 3 层，
            // 键名小写归一；回执按路径展示，便于定位嵌套位置）
            const scanned = unknownToolSensitiveKeys(args);
            if (scanned.paths.length > 0) {
              return formatUnknownToolReceipt(toolName, scanned.paths);
            }
            // 资源上限截断：键没查完 ≠ 没查到 → 保守拦（宁可误拦不可漏拦）
            return scanned.truncated
              ? formatUnknownToolTruncatedReceipt(toolName)
              : null;
          }
          // check：不整工具硬拦，把 watched 键下的字符串值按语义派发到既有两层
          return this.#checkUnknownTool(toolName, args);
        } catch (error) {
          this.#warnUnknownToolScanFailure(toolName, error);
          return null;
        }
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
   * 未登记工具的参数扫描失败（畸形参数：超深结构、抛错的 Proxy 等）：
   * `console.warn` **一次**（不随调用重复，避免刷屏）+ 按**放行**处理 —— fail-open 口径与
   * 「guard 缺失」一致（安全策略层不该把可用性一起赔进去），且绝不让异常抛到宿主 listener。
   */
  #warnUnknownToolScanFailure(toolName: string, error: unknown): void {
    if (this.#unknownToolScanWarned) return;
    this.#unknownToolScanWarned = true;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[security-guard] 未登记工具「${toolName}」的参数扫描失败（${detail}），已按放行处理` +
        "（fail-open；本次会话只告警一次）。",
    );
  }

  /**
   * 参数面超出遍历资源上限（超深 / 超大）：`console.warn` **一次** + **按拦处理**。
   * 「截断」不是放行理由 —— 查不完就保守拦（宁可误拦不可漏拦），与 deny 口径一致。
   */
  #warnUnknownToolScanTruncated(toolName: string): void {
    if (this.#unknownToolTruncationWarned) return;
    this.#unknownToolTruncationWarned = true;
    console.warn(
      `[security-guard] 未登记工具「${toolName}」的参数面超出遍历上限` +
        `（${MAX_WALK_NODES} 个容器节点 / ${MAX_WALK_DEPTH} 层嵌套），已按保守口径拦截` +
        "（fail-closed；本次会话只告警一次）。",
    );
  }

  /**
   * `unknownToolPolicy: "check"`：未登记工具**不整工具硬拦**——把携带的 watched 键下的字符串值
   * （含数组元素）**按键类定向**派发：命令键（`command` / `measureCmd` / `cmd`）→ 命令黑名单层
   * （`commandBlacklist.allowPatterns` 可放行）；路径键与值面绝对路径（`cwd:` 前缀 / `/`、`~/`）→
   * 敏感文件层（`sensitiveFiles.allowedPaths` 可放行）；代码键（`script` / `code` / `program`）只做
   * 路径提取后过敏感文件层、**不整段送命令层**。命中才拦（标准回执前置一行来源标注，标注里的参数
   * 用**完整键路径**，如 `children[].acceptance[].command`），否则放行；
   * 参数面被资源上限**截断**时按保守口径处置：告警一次 + 拦（绝不静默放行）。
   */
  #checkUnknownTool(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    const scan = scanUnknownToolArgs(args);
    const collected = scan.commands.length + scan.paths.length;
    if (collected === 0) {
      if (!scan.truncated) return null;
      this.#warnUnknownToolScanTruncated(toolName);
      return formatUnknownToolTruncatedReceipt(toolName);
    }
    const decided = this.#decideCollected(
      toolName,
      args,
      scan.commands.map((c) => ({
        text: c.text,
        sourceLine: formatUnknownToolCommandSource(toolName, c.keyPath),
      })),
      scan.paths.map((p) => ({
        path: p.path,
        sourceLine: formatUnknownToolPathSource(toolName, p.keyPath),
      })),
      // 未登记工具的操作面未知：敏感层按读写两面标注（与 shell 命令同款措辞）
      "read-write",
    );
    // 已收集值均未命中，但遍历未完成（截断）→ 不得静默放行（保守拦）
    if (decided === null && scan.truncated) {
      this.#warnUnknownToolScanTruncated(toolName);
      return formatUnknownToolTruncatedReceipt(toolName, collected);
    }
    return decided;
  }

  /**
   * 复查一条**不在工具入参里**的命令文本——给「命令来自状态文件 / 契约」这类旁路补执行前检查点
   * （调用方：metric-loop 的 tick 执行 `spec.measureCmd` 前；task-engine 的 executor / 验收执行期）。
   * 与 shell 工具同一口径：命令黑名单层 + 命令内路径的敏感文件层（`allowPatterns` / `allowedPaths`
   * 同样生效）；判定同样记入 `recent()` —— 记录的 `toolName` 存的是**来源标注** `source`
   * （如 `metric_loop{tick} id=x`；字段语义见 `GuardRecord.toolName`）。
   * 回执首行是来源标注；敏感层命中的标签行渲染为「来源：<source>」（D3，不再借「工具：」字段）。
   * 返回 null = 放行；字符串 = deny 回执。
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
      // 标签行用「来源：」形态：这条命令不来自工具入参，写「工具：」会误导
      "source",
    );
    this.#record(label, receipt);
    return receipt;
  }

  /**
   * 「命令文本 + 路径」收集完成后的最终判定：命令黑名单层 → 敏感文件层（两层独立、独立放行）。
   * 官方 shell 工具、插件命令工具、`check` 模式的未登记工具与 `inspectCommand`（外部命令复查）
   * 共用同一口径；`sourceLine` 非空时前置一行来源标注（回执首行）；
   * `operation` 缺省按工具/参数推导（命令面为 read-write），供外部复查标注操作面；
   * `labelKind` 决定敏感层回执的标签行：「工具：」（缺省）还是「来源：」（外部复查）。
   */
  #decideCollected(
    toolName: string,
    args: Record<string, unknown>,
    commands: readonly { text: string; sourceLine?: string }[],
    paths: readonly (string | { path: string; sourceLine?: string })[],
    operation?: "read" | "write" | "read-write",
    labelKind: "tool" | "source" = "tool",
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
            receiptLabelLine(toolName, args, labelKind),
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
      .info(`security-guard blocked tool=${exec.name}: ${logHead}`);
    return receipt;
  };
  const tools = host.tools;
  // 优先单调守卫（2026-10-07 裁定）：它排在 `tools/pre-execute` waterfall **之后**，
  // 拒绝不可被后续监听器翻盘，也不受「某监听器不调 next() 就截断整条链」影响
  if (tools !== undefined && typeof tools.guard === "function") {
    const off = tools.guard((exec) => inspect(exec) ?? undefined);
    host
      .logger?.(name)
      .info("security-guard mounted: monotonic guard（黑名单 + 敏感文件保护）");
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
    .info(
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
