/**
 * 拦截回执：deny 决策的 reason 文本统一措辞。
 *
 * 回执必须包含两要素（TASK 完成门槛）：
 * 1) 拦截原因（哪条规则、为什么）；
 * 2) 放行方式（用户层配置 allowPatterns / allowedPaths）。
 * 宿主会把 reason 物化为工具结果的错误文本（前缀 "Error: "）回传给模型。
 *
 * 另含未登记工具 / 插件命令工具的拦截回执、来源标注行与命中键路径列表的文案上限
 * （判定只看返回值，文案都在本文件）。
 */
import type { CommandHit } from "./blacklist.ts";
import type { SensitiveHit } from "./sensitive.ts";
import {
  MAX_WALK_DEPTH,
  MAX_WALK_NODES,
  pluginFileTool,
} from "./tool-registry.ts";

/** 命令/路径预览截断长度（回执要回传给模型，不能塞整段长文本）。 */
const MAX_PREVIEW = 160;

/** 压成单行并截断。 */
function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_PREVIEW
    ? `${oneLine.slice(0, MAX_PREVIEW)}…`
    : oneLine;
}

/** 命令黑名单层的放行方式说明。 */
const COMMAND_ALLOW_HINT =
  "在该 profile 的 cordis.patch.yml 的 security-guard 条目 config 下，" +
  "向 commandBlacklist.allowPatterns 追加一条能匹配该命令的正则，重载/重启会话后生效；" +
  "或改写为等价的安全命令。";

/** 敏感文件层的放行方式说明。 */
const PATH_ALLOW_HINT =
  "在该 profile 的 cordis.patch.yml 的 security-guard 条目 config 下，" +
  "向 sensitiveFiles.allowedPaths 追加该路径（或其父目录前缀），重载/重启会话后生效。";

/** 命令黑名单命中回执。 */
export function formatCommandReceipt(hit: CommandHit): string {
  return [
    `[security-guard] 已拦截：命令命中黑名单规则「${hit.rule.id}」。`,
    `命令：${truncate(hit.command)}`,
    `原因：${hit.rule.reason}。`,
    `放行方式：${COMMAND_ALLOW_HINT}`,
  ].join("\n");
}

/**
 * 敏感文件命中回执。`label` 是工具/来源的**标签行**（`工具：<工具名>` 或 `来源：<来源标注>`，
 * 由调用方按标签种类渲染）；operation 区分读/写/读写（shell 命令两面都可能）。
 */
export function formatSensitiveReceipt(
  hit: SensitiveHit,
  label: string,
  operation: "read" | "write" | "read-write",
): string {
  const opLabel =
    operation === "read" ? "读取" : operation === "write" ? "写入" : "读写";
  return [
    `[security-guard] 已拦截：${opLabel}敏感文件「${truncate(hit.path)}」命中规则「${hit.rule.id}」。`,
    label,
    `原因：${hit.rule.reason}。`,
    `放行方式：${PATH_ALLOW_HINT}`,
  ].join("\n");
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
export function formatUnknownToolReceipt(
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
export function formatUnknownToolTruncatedReceipt(
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

/** check 模式的来源标注行（与 `inspectCommand` / 插件命令工具同风格：标准回执前置一行来源；键路径与登记表 `commandPaths` 同形）。 */
export function formatUnknownToolCommandSource(
  toolName: string,
  keyPath: string,
): string {
  return `[security-guard] 命令复查来源：未登记工具「${toolName}」的 ${keyPath}。`;
}

/** 路径面来源标注行（同上）。 */
export function formatUnknownToolPathSource(
  toolName: string,
  keyPath: string,
): string {
  return `[security-guard] 路径复查来源：未登记工具「${toolName}」的 ${keyPath}。`;
}

/**
 * 插件命令工具的来源标注行：标准命令回执（规则 id / 命令 / 原因 / 放行方式）不变，
 * 仅前置一行来源——模型据此知道被拦的是哪个工具的哪个命令参数。
 */
export function formatPluginCommandSource(
  toolName: string,
  keyPath: string,
): string {
  return `[security-guard] 拦截来源：插件命令工具「${toolName}」的命令参数（${keyPath}）。`;
}

/** 回执里展示的工具名：读写面随 action 变的插件工具补上 action（如「md_logic replace」）。 */
export function receiptToolName(
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
export function receiptLabelLine(
  toolName: string,
  args: Record<string, unknown>,
  kind: "tool" | "source",
): string {
  return kind === "source"
    ? `来源：${toolName}`
    : `工具：${receiptToolName(toolName, args)}`;
}
