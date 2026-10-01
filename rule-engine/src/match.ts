/**
 * 纯匹配层：文本抽取、命中判定（关键词 / 正则 / 内置谓词）、命中文案摘要。
 *
 * 全部为纯函数，便于单测；正则编译失败不抛错，只返回 warning（由调用方记一次日志，
 * 该条正则视为永不命中，规则其余档位照常生效）。
 */

import type { MatchSpec, PredicateName, RuleSource } from "./types.ts";

/** 正则缺省 flags（大小写不敏感）。 */
const DEFAULT_FLAGS = "i";

/** `form:'notice'` 的 summary 上限（对齐宿主 CONTEXT_SUMMARY_MAX_CHARS）。 */
export const SUMMARY_MAX_CHARS = 120;

/** 内置谓词表：名 → 性质判定（无参数）。 */
const PREDICATES: Record<PredicateName, (text: string) => boolean> = {
  always: () => true,
  "has-non-ascii": (text) => /[^\x00-\x7F]/.test(text),
  "has-cjk": (text) =>
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(
      text,
    ),
  "has-code-block": (text) => text.includes("```"),
};

/** 谓词名是否合法（工具面入参校验用）。 */
export function isPredicateName(value: unknown): value is PredicateName {
  return typeof value === "string" && Object.hasOwn(PREDICATES, value);
}

/** 全部内置谓词名（错误提示用）。 */
export function predicateNames(): PredicateName[] {
  return Object.keys(PREDICATES) as PredicateName[];
}

/** 编译后的匹配器。 */
export interface CompiledMatcher {
  /** 给定文本与**触发节点**，是否命中（空条件语义按节点裁决，见 compileMatcher）。 */
  match(text: string, source: RuleSource): boolean;
  /** 编译期警告（非法正则等），空数组 = 无警告。 */
  warnings: string[];
}

/** 边界类节点（无文本载荷；空条件 = 无条件命中）。 */
export const BOUNDARY_SOURCES: ReadonlySet<RuleSource> = new Set([
  "turn-start",
  "turn-end",
  "step-start",
  "step-end",
  "session-start",
  "compaction",
] as const);

/**
 * 编译命中条件。
 *
 * 缺省语义：条件为空（无 keywords / regex / predicates）时，**边界类节点**（无文本载荷：
 * `turn-start` / `turn-end` / `step-start` / `step-end` / `session-start` / `compaction`）
 * 视为无条件命中，文本类节点（`assistant-text` / `user-message` / `tool-call` / `tool-result`）
 * 视为永不命中（防误配置把每条正文都当命中）。
 *
 * 一条规则可挂多节点（`sources`），故该判定在**判定期**按触发节点裁决（`match(text, source)`）。
 */
export function compileMatcher(spec: MatchSpec | undefined): CompiledMatcher {
  const warnings: string[] = [];
  const keywords = (spec?.keywords ?? [])
    .filter((k): k is string => typeof k === "string" && k.length > 0)
    .map((k) => k.toLowerCase());
  const regexes: RegExp[] = [];
  const flags = spec?.flags ?? DEFAULT_FLAGS;
  for (const pattern of spec?.regex ?? []) {
    if (typeof pattern !== "string" || pattern.length === 0) continue;
    try {
      regexes.push(new RegExp(pattern, flags));
    } catch (err) {
      warnings.push(
        `非法正则 ${JSON.stringify(pattern)}（flags=${flags}）：${String(err)}`,
      );
    }
  }
  const predicates = (spec?.predicates ?? []).filter(isPredicateName);
  const isEmpty =
    keywords.length === 0 && regexes.length === 0 && predicates.length === 0;
  if (isEmpty) {
    return { match: (_text, source) => BOUNDARY_SOURCES.has(source), warnings };
  }
  return {
    match: (text: string): boolean => {
      // 任一档命中即命中；predicates 内部为与关系
      const lower = text.toLowerCase();
      if (keywords.some((k) => lower.includes(k))) return true;
      if (regexes.some((re) => re.test(text))) return true;
      if (predicates.length > 0 && predicates.every((p) => PREDICATES[p](text)))
        return true;
      return false;
    },
    warnings,
  };
}

/**
 * 抽取消息正文：内容块中 `type === "text"` 的文本按序拼接。
 * 畸形输入（非对象 / content 非数组）返回空串，不抛错。
 */
export function messageText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

/** 工具调用文本（名称 + 原始参数串）：`name` 与参数都可能缺省，缺失侧以空串参与。 */
export function toolCallText(name: unknown, args: unknown): string {
  const n = typeof name === "string" ? name : "";
  const a = typeof args === "string" ? args : "";
  return `${n} ${a}`.trim();
}

/** 由注入正文生成一行摘要（去空白折叠 + 截断到 SUMMARY_MAX_CHARS）。 */
export function boundSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_MAX_CHARS
    ? flat
    : `${flat.slice(0, SUMMARY_MAX_CHARS - 3)}...`;
}
