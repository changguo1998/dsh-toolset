/**
 * matcher.ts — 工具检索（BM25 + 中文二元组 + 别名加权，纯函数）。
 *
 * 语料只有几十条工具文档，索引在构建时一次算好；查询只做打分与排序，
 * 延迟在微秒级。字段权重：名称 6 / 名称前缀 3 / 别名 4 / 描述 2 / 参数名 1。
 * 排序稳定：分数降序、同分按名称字典序，便于测试断言。
 */

import { ALIASES } from "./aliases.ts";
import { tokenize, uniqueTokens } from "./tokenize.ts";

/** 一条工具文档（从宿主 schemas 投影而来，只留检索需要的字段）。 */
export interface ToolDoc {
  name: string;
  description: string;
  /** JSON Schema 的 properties 键名参与检索（低权重）。 */
  parameters?: Record<string, unknown>;
}

/** 一条命中。 */
export interface MatchHit {
  name: string;
  score: number;
  /** 命中的查询 token（去重，按查询顺序），用于结果里的「命中」提示与排障。 */
  matched: string[];
}

/** 名称索引的一组（回退用）：`task_*` → 成员名。 */
export interface NameGroup {
  prefix: string;
  names: string[];
}

/** 检索器接口（将来换 hybrid 实现时替换这一层即可）。 */
export interface Matcher {
  /** 按自然语言查询返回命中（只含分数大于 0 的项）。 */
  search(query: string, limit?: number): MatchHit[];
  /** 按名称精确取文档。 */
  get(name: string): ToolDoc | undefined;
  /** 全部工具名（排序后）。 */
  names(): string[];
  /** 按名称前缀（首个下划线前）分组的名称索引。 */
  nameGroups(): NameGroup[];
  /** 文档总数。 */
  size(): number;
}

/** 字段权重（见文件头）。 */
const FIELD_WEIGHT = {
  name: 6,
  prefix: 3,
  alias: 4,
  description: 2,
  parameter: 1,
} as const;

/** BM25 参数。 */
const K1 = 1.2;
const B = 0.75;

/** 名称前缀：`task_decompose` → `task`；无下划线时取全名。 */
function prefixOf(name: string): string {
  const index = name.indexOf("_");
  return index <= 0 ? name : name.slice(0, index);
}

/** 把一条文档摊平成「token → 加权词频」与文档长度（长度 = 加权词频之和）。 */
function indexDoc(
  doc: ToolDoc,
  aliases: Readonly<Record<string, readonly string[]>>,
): { tf: Map<string, number>; length: number } {
  const tf = new Map<string, number>();
  const add = (text: string, weight: number): void => {
    for (const token of tokenize(text)) {
      tf.set(token, (tf.get(token) ?? 0) + weight);
    }
  };
  add(doc.name, FIELD_WEIGHT.name);
  add(prefixOf(doc.name), FIELD_WEIGHT.prefix);
  for (const alias of aliases[doc.name] ?? []) add(alias, FIELD_WEIGHT.alias);
  add(doc.description, FIELD_WEIGHT.description);
  const properties = doc.parameters?.["properties"];
  if (properties !== undefined && typeof properties === "object" && properties !== null) {
    for (const key of Object.keys(properties)) add(key, FIELD_WEIGHT.parameter);
  }
  let length = 0;
  for (const value of tf.values()) length += value;
  return { tf, length };
}

/** 一段描述的「一句话」：首个换行 / 句号之前，最多 80 字符。 */
export function oneLine(description: string, max = 80): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const cut = flat.search(/[。！？.!?]/);
  const sentence = cut === -1 ? flat : flat.slice(0, cut + 1);
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

/**
 * 构建检索器。
 * @param docs 工具文档集。
 * @param aliases 工具名 → 别名列表（缺省用内置表）。
 * @returns 检索器。
 */
export function createMatcher(
  docs: readonly ToolDoc[],
  aliases: Readonly<Record<string, readonly string[]>> = ALIASES,
): Matcher {
  const byName = new Map<string, ToolDoc>();
  const indexed: Array<{ doc: ToolDoc; tf: Map<string, number>; length: number }> = [];
  const df = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    byName.set(doc.name, doc);
    const { tf, length } = indexDoc(doc, aliases);
    indexed.push({ doc, tf, length });
    totalLength += length;
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const count = indexed.length;
  const avgLength = count === 0 ? 0 : totalLength / count;

  const idf = (token: string): number => {
    const freq = df.get(token) ?? 0;
    return Math.log(1 + (count - freq + 0.5) / (freq + 0.5));
  };

  const search = (query: string, limit = 5): MatchHit[] => {
    const trimmed = query.trim();
    if (trimmed.length === 0 || count === 0) return [];
    const tokens = uniqueTokens(tokenize(trimmed));
    const phrase = trimmed.toLowerCase();
    const hits: MatchHit[] = [];

    for (const { doc, tf, length } of indexed) {
      let score = 0;
      const matched: string[] = [];
      for (const token of tokens) {
        const freq = tf.get(token);
        if (freq === undefined || freq <= 0) continue;
        const norm = 1 - B + B * (avgLength === 0 ? 0 : length / avgLength);
        score += idf(token) * ((freq * (K1 + 1)) / (freq + K1 * norm));
        matched.push(token);
      }
      if (matched.length === 0) continue;
      const name = doc.name.toLowerCase();
      const description = doc.description.toLowerCase();
      if (name === phrase) score += 20;
      else if (phrase.length >= 2 && name.includes(phrase)) score += 10;
      if (description.includes(phrase)) score += 4;
      if (score > 0) hits.push({ name: doc.name, score, matched });
    }

    hits.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
    return hits.slice(0, Math.max(0, limit));
  };

  return {
    search,
    get: (name) => byName.get(name),
    names: () => [...byName.keys()].sort((a, b) => a.localeCompare(b)),
    nameGroups: () => {
      const groups = new Map<string, string[]>();
      for (const name of [...byName.keys()].sort((a, b) => a.localeCompare(b))) {
        const prefix = prefixOf(name);
        const list = groups.get(prefix);
        if (list === undefined) groups.set(prefix, [name]);
        else list.push(name);
      }
      return [...groups.entries()]
        .map(([prefix, names]) => ({ prefix: `${prefix}_*`, names }))
        .sort((a, b) => a.prefix.localeCompare(b.prefix));
    },
    size: () => count,
  };
}
