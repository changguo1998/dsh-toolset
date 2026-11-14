/**
 * config.ts — 插件配置的归一化（纯函数，无宿主依赖）。
 *
 * 宿主不校验插件 Config（原样透传），因此这里把所有非法值收敛到缺省：
 * 布尔 / 枚举 / 非负整数 / 列表逐个校验，任何异常都不抛错，只回退。
 * `initialTools` 支持 fnmatch 风格通配（`*` / `?`），由 expandInitialTools
 * 对当前工具名做展开；未命中的模式单独返回，供调用方告警。
 *
 * 旧版遮罩 / 回合档配置（`maskMode` / `revealScope` / `maxRevealed` /
 * `maxPinned` / `ttlTurns` / `disabledWhenTools`）不再生效；命中时记入
 * `ignoredKeys`，接线层每次 apply 告警一次。
 */

/** 遮罩适用范围。 */
export type ApplyTo = "roots" | "all";

/** 插件配置（宿主原样透传，字段全部可选）。 */
export interface Config {
  /** 总开关（缺省 true）。 */
  enabled?: boolean;
  /** 初始完整定义清单，支持通配（缺省 14 个核心工具）。 */
  initialTools?: string[];
  /** 允许保留宿主原样的条件工具（缺省 `web_search` / `web_fetch`）。 */
  allowedWhenTools?: string[];
  /** 管理范围（缺省 `roots`：只管理根代理，子代理不动）。 */
  applyTo?: ApplyTo;
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
  initialTools: string[];
  allowedWhenTools: string[];
  applyTo: ApplyTo;
  matcher: "keyword";
  maxResults: number;
  audit: boolean;
  /** 命中但不再生效的旧配置键（供接线层告警）。 */
  ignoredKeys: string[];
}

/**
 * 缺省初始集（2026-11-13 决策 2）: 高频入口首请求即带完整定义。
 *
 * 不开放: `hash_read` / `hash_edit`（锚点编辑，成对按需咨询）、`todo_write`、
 * 子代理 6 个、`workflow`、goal 3 个、`working_directory`。
 * `read_image` 仅在 attachments 服务挂载时注册；本 profile 已挂 `attachment-local`。
 */
export const DEFAULT_INITIAL_TOOLS: readonly string[] = [
  "bash",
  "read",
  "glob",
  "grep",
  "ask_user_question",
  "skill",
  "write",
  "edit",
  "read_image",
  "web_search",
  "web_fetch",
  "job_output",
  "job_list",
  "job_kill",
];

/**
 * 缺省放行的条件工具（`when` 注册保留宿主原样，会随 readiness 进出）。
 *
 * 白名单外的条件工具由静态 deny 从模型面彻底移除。新增放行项只改这一项配置。
 */
export const DEFAULT_ALLOWED_WHEN_TOOLS: readonly string[] = [
  "web_search",
  "web_fetch",
];

/** 已废弃但仍需识别的配置键。 */
export const LEGACY_CONFIG_KEYS: readonly string[] = [
  "maskMode",
  "revealScope",
  "maxRevealed",
  "maxPinned",
  "ttlTurns",
  "disabledWhenTools",
];

/** 缺省上限。 */
export const DEFAULTS = {
  maxResults: 5,
} as const;

/** 非负整数（非法回退）。 */
function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

/** 非空字符串列表（非法回退到缺省副本）。 */
function nameList(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [...fallback];
}

/** 把宿主透传的配置归一化为全字段版本（永不抛错）。 */
export function resolveConfig(raw?: Config): ResolvedConfig {
  const config = raw ?? {};
  const record = config as Record<string, unknown>;
  const applyTo: ApplyTo = config.applyTo === "all" ? "all" : "roots";
  const maxResults = nonNegativeInt(config.maxResults, DEFAULTS.maxResults);
  return {
    enabled: config.enabled !== false,
    initialTools: nameList(config.initialTools, DEFAULT_INITIAL_TOOLS),
    allowedWhenTools: nameList(
      config.allowedWhenTools,
      DEFAULT_ALLOWED_WHEN_TOOLS,
    ),
    applyTo,
    matcher: "keyword",
    maxResults: Math.min(20, Math.max(1, maxResults)),
    audit: config.audit === true,
    ignoredKeys: LEGACY_CONFIG_KEYS.filter((key) =>
      Object.prototype.hasOwnProperty.call(record, key),
    ),
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
export function isSubagentSession(
  header: SessionHeaderLike | undefined,
): boolean {
  if (header === undefined) return false;
  return (
    header.origin === "subagent" ||
    (typeof header.delegationDepth === "number" && header.delegationDepth > 0)
  );
}
