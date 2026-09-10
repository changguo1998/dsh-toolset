/**
 * session/event 数据源接入：写直达事件过滤器 + 事件摘要化。
 *
 * 契约对齐 DSH-CTX-API.md §1（`ctx.on('session/event', (session, event) => ...)`）与
 * docs/AGENT-ARCHITECTURE-ANALOGY.md §12.2（仅「值得沉淀」类型实时写入）。
 * 过滤白名单覆盖：工具结果（含失败/摘要，tool/result）、用户修正反馈（feedback/record）、
 * 决策计划（plan/mode、goal/change、todo/write、approval/decided）、会话压缩摘要
 * （compaction/summary）。纯逻辑为可测函数；挂接采用结构化 ctx 形态，便于 mock 与 demo。
 * 事件数据量大时由 put 内部按 ~2K token 分块；重复事件经 content_hash 去重。
 *
 * 0.1.5-rc.2 对齐（DSH-CTX-API.md §1/§10）：
 * - tool/result：摄取 `meta` 私有展示载荷（宿主契约要求 JSON-serializable），
 *   以 [tool/meta] 段追加进内容；
 * - compaction/summary：摄取新字段 `shadowedRange{start,end}` 与 `sourceCommandId?`，
 *   输出 [compaction] 结构化段（旧载荷回落 shadowedSeqs）；
 * - SessionEvent.ignorable：白名单外类型一律安全跳过（过滤先于写入、无半写）；
 *   ignorable 仅为词汇外事件的兼容标记，白名单类型带该标记仍正常摄取（不丢数据）；
 * - SessionSeq/SessionLogOffset：本层按 content_hash 去重、session_id 仅作溯源列，
 *   不消费事件 seq / 日志偏移 → N/A（0.1.5-rc.2 序号模型拆分对本插件无影响）。
 */

import type { KnowledgeService } from "./knowledge.ts";

/** 默认写直达白名单：仅这些类型的事件实时沉淀进知识库。 */
export const DEFAULT_PERSIST_TYPES: ReadonlySet<string> = new Set([
  "tool/result",
  "feedback/record",
  "plan/mode",
  "goal/change",
  "todo/write",
  "approval/decided",
  "compaction/summary",
]);

export interface SummarizedEvent {
  title?: string;
  content: string;
  importance: number;
  category: string;
}

/** 递归抽取对象中的文本（string / {text} / {content} / 数组逐项拼接）。 */
export function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(extractText).filter(Boolean).join("\n");
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return extractText(record.content);
    // DSH tool/result 载荷把内容放在 message.content 下。
    if (record.message !== undefined) return extractText(record.message);
    return "";
  }
  return "";
}

/** 递归探测对象中是否存在 truthy 的 isError（tool-result 块标记）。 */
function findIsError(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(findIsError);
  const record = value as Record<string, unknown>;
  if (record.isError) return true;
  return Object.values(record).some(findIsError);
}

function probeTitle(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["title", "topic", "reason", "name"]) {
    if (typeof record[key] === "string" && record[key].length > 0)
      return String(record[key]);
  }
  return undefined;
}

/**
 * 序列化工具私有 meta 载荷（0.1.5-rc.2 `tool/result.meta`，宿主契约要求 JSON-serializable）。
 * 空对象/空数组视为无载荷；不可序列化（循环引用等）安全丢弃，均返回 null。
 */
function serializeToolMeta(meta: unknown): string | null {
  if (meta === null || meta === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(meta);
  } catch {
    return null;
  }
  if (json === undefined || json === "{}" || json === "[]") return null;
  return json;
}

/**
 * compaction/summary 摄取（0.1.5-rc.2）：正文取 summary 文本，追加 [compaction]
 * 结构化段——compactionId、shadowedRange{start,end}（旧载荷回落 shadowedSeqs）、
 * sourceCommandId（可选）、shadowedTokenCount、provider/model。
 * 摘要文本缺失时回落原始 JSON（不丢数据）。
 */
function summarizeCompaction(data: unknown): SummarizedEvent | null {
  if (data === null || typeof data !== "object") {
    const content = JSON.stringify(data, null, 2);
    if (content === undefined || content.length === 0) return null;
    return { content, importance: 3, category: "compaction/summary" };
  }
  const record = data as Record<string, unknown>;
  const text = extractText(record.summary);
  const lines: string[] = ["[compaction]"];
  const field = (key: string, value: unknown): void => {
    if (value !== undefined && value !== null)
      lines.push(`${key}: ${JSON.stringify(value)}`);
  };
  field("compactionId", record.compactionId);
  // 新字段 shadowedRange{start,end}（0.1.5-rc.2）；旧版本载荷回落 shadowedSeqs。
  if (record.shadowedRange !== undefined && record.shadowedRange !== null) {
    field("shadowedRange", record.shadowedRange);
  } else {
    field("shadowedSeqs", record.shadowedSeqs);
  }
  field("sourceCommandId", record.sourceCommandId);
  field("shadowedTokenCount", record.shadowedTokenCount);
  field("provider", record.provider);
  field("model", record.model);
  const footer = lines.join("\n");
  const content =
    text.length > 0 ? `${text}\n\n${footer}` : JSON.stringify(data, null, 2);
  return {
    title: probeTitle(data),
    content,
    importance: 3,
    category: "compaction/summary",
  };
}

/**
 * 将一条事件摘要化为可写入知识库的记录；不属于白名单或无可沉淀文本时返回 null。
 * tool/result：失败（isError/error）importance=4，成功=2，meta 私有载荷以
 * [tool/meta] 段追加；compaction/summary 走专用分支（shadowedRange 等，0.1.5-rc.2）；
 * 其余白名单类型 importance=3。
 */
export function summarizeEvent(
  type: string,
  data: unknown,
): SummarizedEvent | null {
  if (!DEFAULT_PERSIST_TYPES.has(type)) return null;
  if (type === "tool/result") {
    const text = extractText(data);
    if (text.length === 0) return null;
    const isError = findIsError(data);
    // 0.1.5-rc.2：meta 私有展示载荷（如 FsDiffMeta{diffs}）追加为 [tool/meta] 段。
    const meta = serializeToolMeta(
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>).meta
        : undefined,
    );
    return {
      title: probeTitle(data),
      content: meta !== null ? `${text}\n\n[tool/meta]\n${meta}` : text,
      importance: isError ? 4 : 2,
      category: type,
    };
  }
  if (type === "compaction/summary") return summarizeCompaction(data);
  const content = JSON.stringify(data, null, 2);
  if (content === undefined || content.length === 0) return null;
  return { title: probeTitle(data), content, importance: 3, category: type };
}

/** 会话事件最小形态（宿主信封含 type/seq/time/data；本层仅消费 type/data）。 */
export interface SessionEventLike {
  type: string;
  data?: unknown;
  /**
   * 0.1.5-rc.2 兼容标记：宿主对词汇外纯信息事件置 true。
   * 本层白名单判定不受该标记影响——非白名单类型一律安全跳过，
   * 白名单类型带标记仍正常摄取（保守，不丢数据）。
   */
  ignorable?: true;
}

/** 结构化宿主 ctx（DSH cordis 的最小形态）：仅 session/event 事件。 */
export interface HookHost {
  on(
    event: "session/event",
    callback: (session: { id: string }, event: SessionEventLike) => void,
  ): void | (() => void);
}

export interface HooksOptions {
  /** 项目作用域：静态字符串或按事件求值的函数。 */
  project: string | (() => string);
  /** 白名单覆盖；null 表示不过滤（全部事件尝试沉淀）。 */
  persistTypes?: ReadonlySet<string> | null;
}

/** session/event → 知识库 的写直达适配器。 */
export class SessionHooks {
  readonly #kb: KnowledgeService;
  readonly #project: string | (() => string);
  readonly #types: ReadonlySet<string> | null;

  constructor(kb: KnowledgeService, options: HooksOptions) {
    this.#kb = kb;
    this.#project = options.project;
    this.#types =
      options.persistTypes === undefined
        ? DEFAULT_PERSIST_TYPES
        : options.persistTypes;
  }

  /** 订阅宿主 `session/event`；返回解绑函数。 */
  attach(ctx: HookHost): () => void {
    const disposer = ctx.on("session/event", (session, event) => {
      this.handle(session?.id ?? "", event);
    });
    return typeof disposer === "function" ? disposer : () => {};
  }

  /** 处理单条事件：过滤 → 摘要 → put。非白名单/畸形事件安全跳过（过滤先于写入，put 事务化不半写）。 */
  handle(sessionId: string, event: SessionEventLike): void {
    if (event === undefined || event === null || typeof event.type !== "string")
      return;
    if (this.#types !== null && !this.#types.has(event.type)) return;
    const summary = summarizeEvent(event.type, event.data);
    if (summary === null) return;
    this.#kb.put({
      project:
        typeof this.#project === "function" ? this.#project() : this.#project,
      title: summary.title,
      category: summary.category,
      content: summary.content,
      importance: summary.importance,
      sessionId,
      source: { kind: "session", ref: sessionId },
    });
  }
}
