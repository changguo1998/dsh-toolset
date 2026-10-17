/**
 * 归纳：约束句抽取、归一化 key、3-gram 相似合并、置信分档（设计 D2 / D4 / D5）。
 *
 * 纯函数层：不读文件、不调服务、不看时钟（`now` 由调用方给），便于用例直接断言
 * 「固定证据序列 -> 一条偏好」。首期只做统计判定；LLM 文案润色留注入口（D4）。
 */
import { createHash } from "node:crypto";
import {
  addSuppressed,
  touchSession,
  type LedgerEntry,
  type LedgerFile,
} from "./ledger.ts";

/** S1 约束标记词（缺省 12 个；「不要用」「别用」由前两词的前缀匹配覆盖，不单列）。 */
export const DEFAULT_MARKERS: readonly string[] = [
  "不要",
  "别",
  "不用",
  "以后",
  "一律",
  "统一",
  "都",
  "记住",
  "禁止",
  "只能",
  "必须",
  "优先",
];

/** S2 纠正标记（本消息自带纠正语义时，同消息里的约束句权重 x1.5）。 */
export const DEFAULT_CORRECTION_MARKERS: readonly string[] = [
  "不对",
  "错了",
  "不是",
  "重来",
  "重新",
  "我说的是",
  "别这样",
  "又",
  "还是",
];

/** 约束句长度上限（字）：超过则视为普通长文，不当作偏好证据。 */
export const MAX_CONSTRAINT_CHARS = 120;

/** 相似合并阈值（3-gram Jaccard；与 memory-base 机械合并判据同值 0.8）。 */
export const DEFAULT_SIMILARITY = 0.8;

/** S2 纠正语境权重。 */
export const CORRECTION_WEIGHT = 1.5;

/** 一天毫秒数（老化与「最近证据」窗口共用）。 */
export const DAY_MS = 86_400_000;

const SENTENCE_END = /[。！？!?；;\n]+/u;
const KEY_NOISE = /[\s\p{P}]+/gu;
const BULLET_PREFIX = /^\s*(?:[-*•]|\d+[.)])\s*/u;

/** 切句：按句末标点与换行切，去掉空串与列表前缀。 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(SENTENCE_END)) {
    const sentence = raw.replace(BULLET_PREFIX, "").trim();
    if (sentence.length > 0) out.push(sentence);
  }
  return out;
}

/**
 * 抽出承载约束标记的最短句（D2 S1）：句长不超过 `maxChars` 才有资格；没有则返回 null。
 * 取最短句而不是全部句，是为了让一条消息最多产出一条证据（同消息多约束由重复出现自然分列）。
 */
export function extractConstraint(
  text: string,
  markers: readonly string[] = DEFAULT_MARKERS,
  maxChars: number = MAX_CONSTRAINT_CHARS,
): string | null {
  let best: string | null = null;
  for (const sentence of splitSentences(text)) {
    if (!markers.some((marker) => sentence.includes(marker))) continue;
    if ([...sentence].length > maxChars) continue;
    if (best === null || sentence.length < best.length) best = sentence;
  }
  return best;
}

/** 是否含纠正标记（S2）。 */
export function hasCorrectionMarker(
  text: string,
  markers: readonly string[] = DEFAULT_CORRECTION_MARKERS,
): boolean {
  return markers.some((marker) => text.includes(marker));
}

/** 归一化 key：去空白与标点、大小写折叠。 */
export function normalizeKey(text: string): string {
  return text.replace(KEY_NOISE, "").toLowerCase();
}

/** 3-gram 集合（长度不足 3 时整串一个 gram）。 */
export function trigrams(text: string): Set<string> {
  const chars = [...text];
  if (chars.length === 0) return new Set();
  if (chars.length < 3) return new Set([chars.join("")]);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i += 1) {
    grams.add(chars.slice(i, i + 3).join(""));
  }
  return grams;
}

/** 3-gram Jaccard 相似度（空集与任何集合都为 0）。 */
export function trigramJaccard(a: string, b: string): number {
  if (a === b) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** 两条归一化 key 的相似度（相等短路为 1）。 */
export function similarityOf(a: string, b: string): number {
  return a === b ? 1 : trigramJaccard(a, b);
}

/** 由归一化 key 派生稳定 id（重放同一模式不会换 id）。 */
export function entryId(key: string): string {
  return `pref_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** 一条待并入账簿的证据。 */
export interface EvidenceInput {
  /** 偏好正文（用户原话片段；S3 为机械生成的约束句）。 */
  text: string;
  /** 加权证据数（缺省 1；S2 纠正语境 1.5）。 */
  weight: number;
  sessionId: string;
  at: number;
  origin: LedgerEntry["origin"];
  project: string;
  /** 显式归一化 key（S3 指纹 `tool:参数首段`）；缺省按正文归一化。 */
  key?: string;
  title?: string;
}

/** 并入结果。 */
export type MergeOutcome =
  | { kind: "created"; entry: LedgerEntry }
  | { kind: "merged"; entry: LedgerEntry }
  | { kind: "suppressed"; key: string }
  | { kind: "invalid"; reason: "empty" };

/** 按 key（相同或相似）找未退休条目。 */
export function findEntry(
  ledger: LedgerFile,
  key: string,
  similarity: number = DEFAULT_SIMILARITY,
): LedgerEntry | undefined {
  let best: { entry: LedgerEntry; score: number } | undefined;
  for (const entry of ledger.entries) {
    if (entry.status === "retired") continue;
    const score = similarityOf(entry.key, key);
    if (score >= similarity && (best === undefined || score > best.score)) {
      best = { entry, score };
    }
    if (score === 1) break;
  }
  return best?.entry;
}

/** key 是否被抑制（相同或与某个抑制键相似）。 */
export function isSuppressed(
  ledger: LedgerFile,
  key: string,
  similarity: number = DEFAULT_SIMILARITY,
): boolean {
  return ledger.suppressed.some(
    (item) => item === key || similarityOf(item, key) >= similarity,
  );
}

/**
 * 把证据并入账簿：命中抑制键 -> 不产出；命中已有条目 -> 加权计数与刷新时间；
 * 否则新建一条 `observe`。调用方负责随后的置信分档与落状态。
 */
export function mergeEvidence(
  ledger: LedgerFile,
  evidence: EvidenceInput,
  options: { similarity?: number } = {},
): MergeOutcome {
  const similarity = options.similarity ?? DEFAULT_SIMILARITY;
  const key = evidence.key ?? normalizeKey(evidence.text);
  if (key.length === 0) return { kind: "invalid", reason: "empty" };
  if (isSuppressed(ledger, key, similarity)) return { kind: "suppressed", key };
  const existing = findEntry(ledger, key, similarity);
  if (existing !== undefined) {
    existing.evidence += evidence.weight;
    existing.lastSeen = Math.max(existing.lastSeen, evidence.at);
    touchSession(existing, evidence.sessionId);
    if (existing.title === undefined && evidence.title !== undefined) {
      existing.title = evidence.title;
    }
    return { kind: "merged", entry: existing };
  }
  const entry: LedgerEntry = {
    id: entryId(key),
    key,
    text: evidence.text,
    status: "observe",
    evidence: evidence.weight,
    sessions: [],
    origin: evidence.origin,
    project: evidence.project,
    importance: 3,
    firstSeen: evidence.at,
    lastSeen: evidence.at,
  };
  if (evidence.title !== undefined) entry.title = evidence.title;
  touchSession(entry, evidence.sessionId);
  ledger.entries.push(entry);
  return { kind: "created", entry };
}

/** 置信分档。 */
export type ConfidenceTier = "observe" | "candidate" | "confident";

/** 分档阈值。 */
export interface ConfidenceThresholds {
  /** 加权证据数下限（缺省 3）。 */
  evidence: number;
  /** 跨会话数下限（缺省 2）。 */
  sessions: number;
  /** 「最近一次证据」窗口天数（缺省 30）：窗口内 = 高置信，可自动应用。 */
  recentDays: number;
}

/** 分档结果：`importance` 直接取自档位（候选 3 / 高置信 4，D5）。 */
export interface ConfidenceVerdict {
  tier: ConfidenceTier;
  importance: number;
}

/** 按 D5 计算档位：证据 / 会话双门槛决定是否成偏好，最近证据窗口决定是否高置信。 */
export function evaluate(
  entry: LedgerEntry,
  thresholds: ConfidenceThresholds,
  nowMs: number,
): ConfidenceVerdict {
  const enough =
    entry.evidence >= thresholds.evidence &&
    entry.sessions.length >= thresholds.sessions;
  if (!enough) return { tier: "observe", importance: 3 };
  const recent = nowMs - entry.lastSeen <= thresholds.recentDays * DAY_MS;
  return recent
    ? { tier: "confident", importance: 4 }
    : { tier: "candidate", importance: 3 };
}

/** 记一个抑制键（撤销 / 拒绝 / 退休共用）。 */
export function suppress(ledger: LedgerFile, key: string): void {
  addSuppressed(ledger, key);
}
