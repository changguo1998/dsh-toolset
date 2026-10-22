/**
 * config.ts — 插件配置的归一化（纯函数，无宿主依赖）。
 *
 * 宿主不校验插件 Config（原样透传），因此这里把所有非法值收敛到缺省：
 * 布尔 / 枚举 / 非负整数 / 列表逐个校验，任何异常都不抛错，只回退。
 * `initialTools` 支持 fnmatch 风格通配（`*` / `?`），由 expandInitialTools
 * 对当前工具名做展开；未命中的模式单独返回，供调用方告警。
 */

/** 揭示作用域（见 DESIGN D3）。 */
export type RevealScope = "session" | "turn";

/** 遮罩模式。 */
export type MaskMode = "allowlist" | "denylist" | "off";

/** 遮罩适用范围。 */
export type ApplyTo = "roots" | "all";

/** 插件配置（宿主原样透传，字段全部可选）。 */
export interface Config {
  /** 总开关（缺省 true）。 */
  enabled?: boolean;
  /** 遮罩模式（缺省 `allowlist`）。 */
  maskMode?: MaskMode;
  /** 初始可见清单，支持通配（缺省 9 个核心工具）。 */
  initialTools?: string[];
  /** 遮罩范围（缺省 `roots`：只遮根代理，子代理不动）。 */
  applyTo?: ApplyTo;
  /** session 档：新增揭示硬上限；turn 档：回合内容量上限（缺省 12）。 */
  maxRevealed?: number;
  /** 揭示作用域缺省档（缺省 `session`）。 */
  revealScope?: RevealScope;
  /** 仅 turn 档：揭示项闲置多少回合后收回；0 = 关闭。 */
  ttlTurns?: number;
  /** 仅 turn 档：同时钉住的揭示项上限（缺省 3）。 */
  maxPinned?: number;
  /** 检索实现（v1 只有 keyword，留 hybrid 接缝）。 */
  matcher?: "keyword";
  /** 单次返回上限（1 至 20，缺省 5）。 */
  maxResults?: number;
  /** 是否写 `tool-consult/*` 审计事件（缺省 false）。 */
  audit?: boolean;
}

/** 归一化后的配置（全部字段必有值）。 */
export interface ResolvedConfig {
  enabled: boolean;
  maskMode: MaskMode;
  initialTools: string[];
  applyTo: ApplyTo;
  maxRevealed: number;
  revealScope: RevealScope;
  ttlTurns: number;
  maxPinned: number;
  matcher: "keyword";
  maxResults: number;
  audit: boolean;
}

/** 缺省核心清单（2026-10-22 人工裁定：9 个，含 skill）。 */
export const DEFAULT_INITIAL_TOOLS: readonly string[] = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "todo_write",
  "ask_user_question",
  "skill",
];

/** 缺省上限。 */
export const DEFAULTS = {
  maxRevealed: 12,
  ttlTurns: 0,
  maxPinned: 3,
  maxResults: 5,
} as const;

/** 非负整数（非法回退）。 */
function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

/** 把宿主透传的配置归一化为全字段版本（永不抛错）。 */
export function resolveConfig(raw?: Config): ResolvedConfig {
  const config = raw ?? {};
  const mode: MaskMode = config.maskMode === "denylist" || config.maskMode === "off"
    ? config.maskMode
    : "allowlist";
  const scope: RevealScope = config.revealScope === "turn" ? "turn" : "session";
  const applyTo: ApplyTo = config.applyTo === "all" ? "all" : "roots";
  const tools = Array.isArray(config.initialTools)
    ? config.initialTools.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [...DEFAULT_INITIAL_TOOLS];
  const maxResults = nonNegativeInt(config.maxResults, DEFAULTS.maxResults);
  return {
    enabled: config.enabled !== false,
    maskMode: mode,
    initialTools: [...tools],
    applyTo,
    maxRevealed: nonNegativeInt(config.maxRevealed, DEFAULTS.maxRevealed),
    revealScope: scope,
    ttlTurns: nonNegativeInt(config.ttlTurns, DEFAULTS.ttlTurns),
    maxPinned: nonNegativeInt(config.maxPinned, DEFAULTS.maxPinned),
    matcher: "keyword",
    maxResults: Math.min(20, Math.max(1, maxResults)),
    audit: config.audit === true,
  };
}

/** fnmatch 风格匹配：`*` 任意长度、`?` 单字符，其余按字面量转义。 */
export function matchGlob(pattern: string, name: string): boolean {
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(name);
}

/** 通配展开结果。 */
export interface ExpandedTools {
  /** 命中的工具名（去重、排序）。 */
  names: string[];
  /** 没有命中任何工具的原始模式（供告警）。 */
  unknown: string[];
}

/**
 * 把 `initialTools` 模式串对当前工具名展开。
 * @param patterns 配置的模式串。
 * @param known 当前已知的工具名。
 * @returns 命中的名字与未命中的模式。
 */
export function expandInitialTools(
  patterns: readonly string[],
  known: readonly string[],
): ExpandedTools {
  const names = new Set<string>();
  const unknown: string[] = [];
  for (const pattern of patterns) {
    let hit = false;
    for (const name of known) {
      if (matchGlob(pattern, name)) {
        names.add(name);
        hit = true;
      }
    }
    if (!hit) unknown.push(pattern);
  }
  return { names: [...names].sort((a, b) => a.localeCompare(b)), unknown };
}

/** 会话头的最小形态（只取子代理判定需要的字段）。 */
export interface SessionHeaderLike {
  origin?: string;
  delegationDepth?: number;
}

/** 是否子代理会话（`applyTo: "roots"` 时跳过）。 */
export function isSubagentSession(header: SessionHeaderLike | undefined): boolean {
  if (header === undefined) return false;
  return header.origin === "subagent"
    || (typeof header.delegationDepth === "number" && header.delegationDepth > 0);
}
