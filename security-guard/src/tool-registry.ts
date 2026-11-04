/**
 * 规则表: 拦截面登记表与未登记工具的键集 / 键深 / 遍历上限.
 * 只放纯数据与查表函数, 不做配置解析与判定; 对外面只经 `security-guard/src/index.ts` 统一 re-export.
 */
/**
 * 拦截面：shell 工具 → command 文本；run_code → code 文本；文件工具 → 路径参数；
 * 插件文件工具 → 登记路径参数；插件命令工具 → 登记命令参数（见 PLUGIN_COMMAND_TOOLS）。
 */
export const SHELL_TOOLS = new Set(["bash", "shell", "pwsh"]);
export const RUN_CODE_TOOLS = new Set(["run_code"]);
// read_image 是官方读面工具（参数 file_path），与 read 同级：只过敏感文件层读侧
export const FILE_TOOLS = new Set([
  "read",
  "read_image",
  "write",
  "edit",
  "patch",
  "grep",
  "glob",
]);
export const FILE_PATH_KEYS = ["file_path", "path", "target", "file"] as const;
const WRITE_FILE_TOOLS = new Set(["write", "edit", "patch"]);

/** 插件文件工具描述符：登记本仓插件工具的读写面与路径参数名。 */
export interface PluginFileTool {
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
export function pluginFileTool(toolName: string): PluginFileTool | undefined {
  return Object.hasOwn(PLUGIN_FILE_TOOLS, toolName)
    ? PLUGIN_FILE_TOOLS[toolName]
    : undefined;
}

/** 插件命令工具描述符：登记入参里带 shell 命令文本的插件工具。 */
export interface PluginCommandTool {
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
 *   不含命令文本），故检查点落在声明处（残留边界见 README「边界与限制」）；
 * - `script_run`：`script`（脚本正文，由解释器执行，见 script-interpreter——与官方
 *   `run_code` 的 `code` 同口径，命中即 deny）；
 * - `herdr_run` / `herdr_text` / `herdr_key`：herdr-use 十个具名工具里的三个命令面
 *   （其余 `herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` /
 *   `herdr_close` / `herdr_label` 无命令面）——`herdr_run` 的 `command`（提交终端的命令，
 *   文本 + 回车一次提交）、`herdr_text` 的 `text`（注入终端的文本，与 `herdr_run` 只差
 *   是否补回车，故同纳）与 `herdr_key` 的 `keys[]`（按键串数组，**逐元素**过命令层；
 *   `keys` 是数组，走 `commandPaths` —— 见下）。
 *
 * **登记写法的三条口径**（写错即假覆盖：名字在册但运行时不检查）：
 * 1. `commandKeys` 只收**顶层非空 string**，数组值**静默失效** —— 数组参数必须走
 *    `commandPaths`（如 `herdr_key` 的 `keys`）。
 * 2. `commandPaths` 走点号路径，段名带 `[]` 表示该值是数组、逐元素展开（如 `keys[]`）。
 * 3. **登记即脱离未登记工具策略**：门禁分支是 `plugin === undefined && commandTool === undefined`，
 *    工具名一旦在册，`unknownToolPolicy` 对它不再生效 —— 登记等于承诺「这套参数面是真的」。
 *
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
  script_run: { commandKeys: ["script"] },
  // herdr-use 命令面：herdr_run 的 command 与 herdr_text 的 text 是顶层字符串，
  // 走 commandKeys；herdr_key 的 keys 是字符串数组：commandKeys 对数组值静默失效，
  // 必须走 commandPaths 才真正生效。
  herdr_run: { commandKeys: ["command"] },
  herdr_text: { commandKeys: ["text"] },
  herdr_key: { commandPaths: ["keys[]"] },
};

/** 命令工具登记表查表（与文件表同口径：Object.hasOwn，原型链属性名视同未登记）。 */
export function pluginCommandTool(
  toolName: string,
): PluginCommandTool | undefined {
  return Object.hasOwn(PLUGIN_COMMAND_TOOLS, toolName)
    ? PLUGIN_COMMAND_TOOLS[toolName]
    : undefined;
}

/**
 * 未登记工具的路径参数键名（**键集单一来源**：本包唯一一份，`security-guard/scripts/tool-surface-check.mjs`
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
 * `security-guard/scripts/tool-surface-check.mjs` 复用，脚本与引擎不各维护一份）。
 * **3 层**：顶层 → 数组元素 → 其对象成员 → 再一层数组元素 —— **数组透明、不消费键深**
 * （数组元素对象与数组自身同键深）；更深处的同形嵌套不再纳入（**语义**上限，避免深层误伤）。
 * 命中的键以**完整键路径**表示（`children[].acceptance[].command`，与登记表 `commandPaths` 同形）。
 */
export const UNKNOWN_TOOL_KEY_DEPTH = 3;

/**
 * 工具覆盖面快照：给 `security-guard/scripts/tool-surface-check.mjs` 复用的**机器可读单一来源**
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
export function watchedKeyKind(
  key: string,
): "path" | "command" | "code" | null {
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
export const MAX_WALK_NODES = 4096;

/**
 * 遍历**嵌套深度**上限（容器层数）。数组透明不消费**键深**，但深数组照样加深**递归栈**：
 * 实测本遍历器约 3500 层即 `RangeError`，故单列一条栈深上限（64 层远超任何真实参数面）。
 */
export const MAX_WALK_DEPTH = 64;

/**
 * 文件工具的敏感文件操作面：命令登记表（命令经 shell 执行，读写两面都可能）→ 插件文件
 * 登记表（writeWhen 为真 → write；read-write 非写 action → read）→ shell 读写两面 →
 * 写类官方工具 write → 其余 read。官方工具语义不变。
 */
export function toolOperation(
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
