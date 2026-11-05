/**
 * 判定核心（纯函数, 零 IO）：拿整回合助手正文比对术语表快照，产出需要更正的位置与注入文案。
 * **只报不改** —— 不改回复正文，也不改任何文件。
 *
 * 口径与 `dev/standard`（`check:docs` 的术语检查）对齐：条件型术语整行跳过、豁免标记行跳过、
 * 已知误配按上下文跳过；**不加代码段掩码**（2026-11-05 用户裁定, 见追踪文档决策项 3）。
 */

import { GLOSSARY_SNAPSHOT } from "./glossary.generated.ts";

/** 注入消息的 summary（rule-engine 的 `dedupeInRecord` 按它计数）。 */
export const TERM_FEEDBACK_SUMMARY = "术语提醒";

/** 每条反馈最多列出几处（缺省 8）。 */
export const DEFAULT_MAX_HITS = 8;

/**
 * 豁免标记：含这些词的行允许引用旧称（首次出现写「原名」的口径）。
 * 与 `dev/standard/rules.mjs` 的 `EXEMPT_MARKERS` 同口径, 改动时两边同步。
 */
const EXEMPT_MARKERS = ["原名", "旧称", "历史对照", "不再使用"];

/**
 * 已知误配：旧称恰好落在别的词里（如「夺回归属」里的「回归」）, 同句出现片段即跳过。
 * 与 `dev/standard/rules.mjs` 的 `FALSE_POSITIVES` 同口径, 改动时两边同步。
 */
const FALSE_POSITIVES: Readonly<Record<string, readonly string[]>> = {
  回归: ["夺回归属"],
};

/** 「应当使用」写作「见『推荐术语』」时的具体说法（GLOSSARY「推荐术语」表的分组）。 */
const FALLBACK_SUGGESTION =
  "按语境改用具体说法（存储 / 审计 / 实现 / 投递 / 文档 / 条目）";

/** 一处命中。 */
export interface TermHit {
  /** 命中所在行号（1 起）。 */
  line: number;
  /** 回复正文里的旧称。 */
  from: string;
  /** 应当使用。 */
  to: string;
  /** 术语表的条件与例外原文。 */
  note: string;
  /** 是否界面名称（`term.interface`）。 */
  isInterface: boolean;
}

/** 判定选项。 */
export interface CheckOptions {
  /** 每条反馈最多列出几处（缺省 8；`0` = 不限）。 */
  maxHits?: number;
}

/** 判定结果：`hits` 受上限截断, `total` 是命中的旧称种数（全量）。 */
export interface CheckResult {
  hits: TermHit[];
  total: number;
}

/** 上限取值：有限非负数按值 —— `0` = 不设上限；未设 / 非法值回退 `fallback`。 */
function limitOrInfinity(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return fallback;
  return value === 0 ? Number.POSITIVE_INFINITY : Math.floor(value);
}

/**
 * 逐行扫描正文：条件型术语跳过、豁免标记行跳过、已知误配跳过，其余行做子串命中；
 * 同一旧称只记首次出现（每回合每词一条）。
 */
export function checkTerms(text: string, options?: CheckOptions): CheckResult {
  const maxHits = limitOrInfinity(options?.maxHits, DEFAULT_MAX_HITS);
  const hits: TermHit[] = [];
  const seen = new Set<string>();
  let total = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (EXEMPT_MARKERS.some((marker) => line.includes(marker))) continue;
    for (const row of GLOSSARY_SNAPSHOT) {
      if (row.conditional) continue;
      for (const from of row.from) {
        if (seen.has(from) || !line.includes(from)) continue;
        if (
          (FALSE_POSITIVES[from] ?? []).some((snippet) =>
            line.includes(snippet),
          )
        )
          continue;
        seen.add(from);
        total += 1;
        if (hits.length < maxHits) {
          hits.push({
            line: i + 1,
            from,
            to: row.to,
            note: row.note,
            isInterface: row.isInterface,
          });
        }
      }
    }
  }
  return { hits, total };
}

/**
 * 渲染注入正文（无命中返回 null）：逐条给出行号、旧称与应当使用，末尾要求模型更正后完整重发。
 * 文案口径同 `md-table-check`：只针对回复正文、不改仓库文件；并对「不加掩码」的已知噪声写明
 * 「引用示例 / 历史对照可忽略本条」。
 */
export function renderFeedback(
  text: string,
  options?: CheckOptions,
): { text: string; summary: string } | null {
  const { hits, total } = checkTerms(text, options);
  if (hits.length === 0) return null;
  const out: string[] = [
    "[term-check] 上一条回复正文里出现了「禁止术语」表里的旧称（本提示只针对回复正文，与仓库文件无关）：",
  ];
  for (const hit of hits) {
    const suggestion = hit.to.includes("推荐术语")
      ? FALLBACK_SUGGESTION
      : hit.to;
    const kind = hit.isInterface ? "，界面名称" : "";
    out.push(
      `- 第 ${hit.line} 行：「${hit.from}」→ 用「${suggestion}」${kind}`,
    );
  }
  if (total > hits.length) out.push(`另有 ${total - hits.length} 处未列出。`);
  out.push(
    "请按表里的「应当使用」更正这些说法后，把上一条回复完整重发一次；若某条属引用示例或历史对照，可忽略本条；不要修改仓库里的任何文件或文档。",
  );
  return { text: out.join("\n"), summary: TERM_FEEDBACK_SUMMARY };
}
