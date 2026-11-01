/**
 * 命令解析: 从工具入参里提取命令文本与路径 (含未登记工具的键面 / 值面扫描).
 * 只做提取与归一, 不做判定; 对外面只经 `src/index.ts` 统一 re-export.
 */
import { extractCommandPaths } from "./sensitive.ts";
import {
  MAX_WALK_DEPTH,
  MAX_WALK_NODES,
  UNKNOWN_TOOL_KEY_DEPTH,
  watchedKeyKind,
  type PluginCommandTool,
  type PluginFileTool,
} from "./tool-registry.ts";

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
export interface UnknownToolKeyScan {
  paths: string[];
  truncated: boolean;
}

/** 未登记工具是否携带潜在路径/命令参数：返回命中的键路径（去重、保序）与截断标记。 */
export function unknownToolSensitiveKeys(
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

/** check 模式的键面扫描结果（keyPath = 来源参数**完整键路径**，回执来源标注行用）。 */
export interface UnknownToolScan {
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
export function scanUnknownToolArgs(
  args: Record<string, unknown>,
): UnknownToolScan {
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
export function pluginCommands(
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

export function asStringRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** 插件工具的路径提取：pathKeys 取 string 值，pathArrayKeys 取数组中的 string 元素。 */
export function pluginFilePaths(
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

export function firstString(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
