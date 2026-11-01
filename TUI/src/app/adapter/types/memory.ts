// src/app/adapter/types/memory.ts — 知识库 / 记忆层级 / 指标循环

/** memory-base 概要（C4 前置；`KnowledgeBundleSummary` 的 TUI 侧宽松子集） */
export interface KnowledgeBundleSummaryLike {
  ready: boolean;
  dbPath: string;
  chunkCount: number;
  sourceCount: number;
}

/** 管理面可写的记忆层级：U（user）/ P（project）两层；S（session）层按会话隔离，管理面不处理。 */
export type ManagedTier = "project" | "user";

/**
 * 管理面层级判定：层级只认适配层声明的 `ManagedTier`，调用方不再各自自比字面量
 * （`/memory list|add|remove|replace` 的 tier 校验统一走这里）。
 */
export function isManagedTier(value: unknown): value is ManagedTier {
  return value === "project" || value === "user";
}

/** S 层（会话层）标识：按会话隔离，管理面不处理；`/memory` 参数校验据它给出专属提示。 */
export const SESSION_TIER = "session";

/** `/memory` 管理面的行地址（memory-base 管理面只处理 U / P 层）。 */
export interface MemoryRowRef {
  tier: ManagedTier;
  kind: string;
  id: number;
}

/** ctx.get('memory') 面：八读 + 三管理写（memory-base cordis provide；缺失时 /memory 提示不可用） */
export interface KnowledgeServiceLike {
  getSummary?(): KnowledgeBundleSummaryLike | undefined;
  whenReady?(): Promise<{ summary?(): KnowledgeBundleSummaryLike | undefined }>;
  /** 跨全域检索（LayeredHit 宽松形态；`/memory search` 只读呈现）。 */
  search?(opts: {
    query: string;
    project?: string;
    kind?: string;
    limit?: number;
  }): Promise<unknown[]> | unknown[];
  /** 跨 kind 列举（管理面定位：行带 `id` / `tier` / `kind`）。 */
  list?(opts?: {
    kind?: string;
    tier?: ManagedTier;
    limit?: number;
  }): Promise<unknown[]> | unknown[];
  /** 管理面：删除 U / P 条目（返回删除条数；S 层等参数级错误抛错）。 */
  forget?(refs: readonly MemoryRowRef[]): Promise<number>;
  /** 管理面：就地更新 U / P 条目（失败时原行不动）。 */
  update?(
    ref: MemoryRowRef,
    patch: { content: string; title?: string; importance?: number },
  ): Promise<{ ok: boolean; skipped?: string }>;
  /** 管理面：用户直写 U / P（内容闸门与 preWrite 仍生效）。 */
  remember?(input: {
    content: string;
    kind: string;
    title?: string;
    tier: ManagedTier;
  }): Promise<{ ids?: number[]; skipped?: string }>;
}

/** metric-loop 循环概要素（C5 前置；`LoopSummary` 的 TUI 侧宽松子集） */
export interface LoopSummaryLike {
  id: string;
  status?: string;
  stopReason?: string | null;
  measureCmd?: string | null;
  direction?: "min" | "max";
  window?: number;
  maxRounds?: number;
  rounds?: number;
  best?: number | null;
  streak?: number;
  updatedAt?: number;
}

/** ctx.get('metricLoop') 只读查询面（metric-loop cordis provide，C5 已挂载；缺失时 /loop 提示不可用）。
 *  首版输出仅用 list()；status(id) 单查未被 TUI 消费，接入时定义域类型后再暴露。 */
export interface MetricLoopLike {
  list?(): readonly LoopSummaryLike[];
}

/** ctx.get('symbolNormalizer') 服务面（symbol-normalizer 插件 provide；缺失时 TUI 原文透传、
 *  无 notice——插件可能在 TUI 之后装载，消费侧懒读，见 index.ts App.symbols()）。 */
export interface SymbolNormalizerLike {
  /** 展示层归一：返回替换后的文本（TUI 只消费 text 字段）。 */
  normalize(text: string): { text: string };
  /** 订阅回合审查事件（notice 展示用）；返回注销函数。 */
  onReview(
    listener: (event: { sessionId: string; notice: string }) => void,
  ): () => void;
}
