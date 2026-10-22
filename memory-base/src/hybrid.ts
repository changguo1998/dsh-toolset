/**
 * 混合检索的纯函数层（策略常量 / 词项切分 / 邻近窗口 / RRF 融合）。
 *
 * 分工：本文件只做字符串与数学，**不碰 SQLite**——SQL 与结果行留在 `knowledge.ts`。
 * 口径见 `docs/implementation/2026-10-22-memory-hybrid-retrieval.md` 的「决策」：
 * - 策略只有两档：`bm25`（缺省，等价改造前的单词面行为）与 `hybrid`（多路召回 + RRF）；
 * - 各路的分数（BM25 / trigram / LIKE 常量 0 / 邻近跨度）量纲不可比，故融合只用**路内名次**；
 * - 融合分取负后写进 `SearchHit.score`，沿用「分数越小越相关」的既有语义。
 */

/** 检索策略：`bm25` = 现有单词面行为（缺省）；`hybrid` = 多路召回 + RRF 融合。 */
export type SearchMode = "bm25" | "hybrid";

/** 合法的策略值（工具参数与调用方共用）。 */
export const SEARCH_MODES: readonly SearchMode[] = ["bm25", "hybrid"];

/** RRF 平滑常数（取原论文的 60，不做调参）。 */
export const RRF_K = 60;

/** 混合模式每路候选池 = `limit * 该倍数`，再夹到下限与上限之间。 */
export const HYBRID_POOL_FACTOR = 4;
export const HYBRID_POOL_MIN = 20;
export const HYBRID_POOL_CAP = 200;

/** 词项数上限：多词查询的 trigram / LIKE / 邻近最多看这么多词。 */
export const MAX_TERMS = 8;

/** trigram 分词器要求子串至少 3 字符才能召回。 */
export const TRIGRAM_MIN_CHARS = 3;

/** 邻近扫描的文本长度上限（字符）：长文只扫前一段，避免同一行被反复全文扫描。 */
export const PROXIMITY_SCAN_CHARS = 4000;

/** 邻近路要求一行至少命中的词项数（单词查询没有「邻近」可言）。 */
export const PROXIMITY_MIN_TERMS = 2;

/**
 * 邻近的窗口跨度上限（字符）：词项共现要落在同一小窗口内才算「邻近」。
 * 取句内量级（64 字符 ≈ 一句短语），避免把「一篇长文里恰好都出现」当成邻近。
 */
export const PROXIMITY_MAX_SPAN = 64;

/** 单行最多收集的词项出现位置数（防止超长重复文本拖慢窗口计算）。 */
const MAX_MARKS = 4096;

/** 策略值判定（工具参数用宽松读取：非法值由调用方回落缺省）。 */
export function isSearchMode(value: unknown): value is SearchMode {
  return value === "bm25" || value === "hybrid";
}

/** 混合模式每路的候选池大小（`limit` 已由调用方 clamp）。 */
export function hybridPoolSize(limit: number): number {
  return Math.max(
    HYBRID_POOL_MIN,
    Math.min(limit * HYBRID_POOL_FACTOR, HYBRID_POOL_CAP),
  );
}

/** 词项首尾的标点 / 符号剥掉（`hybrid,` 与 `hybrid` 视为同一词；正文里的符号不动）。 */
const EDGE_PUNCTUATION = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

/**
 * 词项切分：按空白切分、剥首尾标点、去重、截到 `max` 个。
 * 只服务 trigram / LIKE / 邻近三路；porter 路仍用原查询串（保留 FTS5 语法能力）。
 */
export function queryTerms(query: string, max = MAX_TERMS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.split(/\s+/u)) {
    const term = raw.replace(EDGE_PUNCTUATION, "");
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

/** FTS5 字符串字面量：引号包裹、内部引号翻倍（转义后不再有语法含义）。 */
function ftsPhrase(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * trigram 路查询：≥3 字符的词项各自作为 phrase 字面量，用 `OR` 连接。
 * 词项全都太短时返回 `undefined`（该路无候选，交由 LIKE 路兜底）。
 */
export function trigramQuery(terms: readonly string[]): string | undefined {
  const phrases = terms
    .filter((term) => [...term].length >= TRIGRAM_MIN_CHARS)
    .map(ftsPhrase);
  return phrases.length === 0 ? undefined : phrases.join(" OR ");
}

/** 邻近窗口结果：覆盖的词项数 + 覆盖它们的最小窗口跨度（未覆盖 2 个以上时 `-1`）。 */
export interface ProximitySpan {
  covered: number;
  span: number;
}

/**
 * 邻近计算：在一行文本里找各词项（小写化、子串语义）的出现位置，用滑动窗口求
 * 「覆盖全部出现词项」的最小跨度。跨度为字符数（末位置减首位置）。
 */
export function proximitySpan(
  text: string,
  terms: readonly string[],
): ProximitySpan {
  const hay = text.slice(0, PROXIMITY_SCAN_CHARS).toLowerCase();
  const marks: Array<{ pos: number; term: number }> = [];
  const termCounts = new Map<number, number>();
  for (let index = 0; index < terms.length; index += 1) {
    const needle = (terms[index] as string).toLowerCase();
    if (needle.length === 0) continue;
    let from = 0;
    let found = false;
    while (marks.length < MAX_MARKS) {
      const pos = hay.indexOf(needle, from);
      if (pos < 0) break;
      marks.push({ pos, term: index });
      found = true;
      from = pos + needle.length;
    }
    if (found) termCounts.set(index, 0);
  }
  const covered = termCounts.size;
  if (covered < PROXIMITY_MIN_TERMS) return { covered, span: -1 };

  marks.sort((a, b) => a.pos - b.pos || a.term - b.term);
  let span = Number.POSITIVE_INFINITY;
  let missing = covered;
  let left = 0;
  for (let right = 0; right < marks.length; right += 1) {
    const mark = marks[right] as { pos: number; term: number };
    const count = (termCounts.get(mark.term) ?? 0) + 1;
    termCounts.set(mark.term, count);
    if (count === 1) missing -= 1;
    while (missing === 0 && left <= right) {
      const first = marks[left] as { pos: number; term: number };
      span = Math.min(span, mark.pos - first.pos);
      const leftCount = (termCounts.get(first.term) ?? 0) - 1;
      termCounts.set(first.term, leftCount);
      if (leftCount === 0) missing += 1;
      left += 1;
    }
  }
  return { covered, span: Number.isFinite(span) ? span : -1 };
}

/**
 * RRF 融合：`paths` 每一项是一路命中的键序（最相关在前），返回 `键 → 融合分`，
 * 分值为各路 `1 / (K + rank + 1)` 之和（rank 从 0 起）。
 */
export function rrfFuse(
  paths: ReadonlyArray<readonly string[]>,
  k = RRF_K,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const path of paths) {
    for (let rank = 0; rank < path.length; rank += 1) {
      const key = path[rank] as string;
      fused.set(key, (fused.get(key) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return fused;
}
