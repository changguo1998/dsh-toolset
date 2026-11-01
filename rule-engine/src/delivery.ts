/**
 * 上下文注入层：待注入段 → 逐段闸门（每回合条数上限 + 同正文去重）→ 按 delivery 分组 →
 * 合并成一条交注入器。
 *
 * 本层只做「怎么交付」，不判断该不该产出段（规则求值见 evaluation.ts、消费者调度见
 * consumers.ts），也不持有会话态：每回合用量表由调用方传入。另附按记录去重的读面
 * `countInRecord`（会话记录里本引擎注入的条数），读面本体由接线层合成。
 */

import { SOURCE_KIND } from "./inject.ts";
import type { Injector, RuleDelivery } from "./types.ts";

/** 待注入的一段（规则命中或消费者反馈）。 */
export interface Segment {
  sourceId: string;
  delivery: RuleDelivery;
  text: string;
  summary: string;
}

/** 单回合注入用量（条数 + 已用正文）。 */
export interface TurnUsage {
  count: number;
  texts: Set<string>;
}

/** 一次落盘交付的入参。 */
export interface DeliveryInput {
  /** 本次节点产出的段（按规则与消费者的询问顺序）。 */
  readonly segments: readonly Segment[];
  readonly sessionId: string;
  readonly turn: number;
  /** 同一会话同一回合的注入上限。 */
  readonly maxInjectionsPerTurn: number;
  /** 本会话的各回合用量表（就地记账）。 */
  readonly injected: Map<number, TurnUsage>;
  readonly injector: Injector;
  readonly warn: (message: string) => void;
}

/** 逐段闸门 → 按 delivery 分组 → 合并为一条写入（注入失败只告警，不向上抛）。 */
export function writeSegments(input: DeliveryInput): void {
  const { segments, sessionId, turn, injected, injector, warn } = input;
  if (segments.length === 0) return;
  const groups = new Map<RuleDelivery, Segment[]>();
  for (const segment of segments) {
    const list = groups.get(segment.delivery) ?? [];
    list.push(segment);
    groups.set(segment.delivery, list);
  }
  for (const [delivery, list] of groups) {
    const usage = injected.get(turn) ?? {
      count: 0,
      texts: new Set<string>(),
    };
    const kept: Segment[] = [];
    for (const segment of list) {
      if (usage.count >= input.maxInjectionsPerTurn) {
        warn(
          `回合 ${turn} 注入段数已达上限 ${input.maxInjectionsPerTurn}，来源 "${segment.sourceId}" 的注入跳过`,
        );
        continue;
      }
      if (usage.texts.has(segment.text)) continue;
      usage.count += 1;
      usage.texts.add(segment.text);
      kept.push(segment);
    }
    injected.set(turn, usage);
    if (kept.length === 0) continue;
    const sourceId = kept.map((item) => item.sourceId).join("+");
    try {
      injector.inject({
        sourceId,
        sessionId,
        delivery,
        text: kept.map((item) => item.text).join("\n\n"),
        summary: kept[0]?.summary ?? "",
        // 合并注入（多段）时才带各段摘要；单段与 `summary` 相同，省略
        ...(kept.length > 1
          ? { summaries: kept.map((item) => item.summary) }
          : {}),
      });
    } catch (err) {
      warn(`来源 "${sourceId}" 注入失败：${String(err)}`);
    }
  }
}

/** 会话记录里本引擎注入的条数（`summary` 或 `summaries` 命中该 key）；读面由接线层给出。 */
export function countInRecord(
  messagesOf: ((sessionId: string) => readonly unknown[]) | undefined,
  sessionId: string,
  key: string,
): number {
  const messages = messagesOf?.(sessionId);
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    const source = (
      message as {
        source?: { kind?: unknown; summary?: unknown; summaries?: unknown };
      } | null
    )?.source;
    if (source?.kind !== SOURCE_KIND) continue;
    if (source.summary === key) {
      count += 1;
      continue;
    }
    if (Array.isArray(source.summaries) && source.summaries.includes(key)) {
      count += 1;
    }
  }
  return count;
}
