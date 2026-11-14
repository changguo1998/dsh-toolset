/**
 * flow-track/src/inject.ts — 回合边界注入文本的组装（纯函数，零 IO）。
 *
 * 决策项 4.4 起**树级内容不再由本包注入**：阶段模板与推进状态的渲染已退役，
 * 当前节点内容改由 task-engine 取数、pin-note 保持。本包只留两类
 * 非树级职责：合规提示（本轮有写类调用却没有任何流程记录）与最近一条流程记录摘要。
 * 口径：两类都没有就返回 undefined（不刷屏）。
 */

import type { FlowRecord } from "./store.ts";

/** 组装入参。 */
export interface DecideInput {
  /** 最近的流程记录（时间正序）。 */
  records: readonly FlowRecord[];
  /** 本会话本轮是否出现过写类工具调用。 */
  writeSeen: boolean;
  /** 最后一次写类工具名（有就写进提示）。 */
  lastWriteTool?: string;
}

/** 合规提示（只提示不拦截）。 */
export function renderCompliance(input: DecideInput): string | undefined {
  if (!input.writeSeen) return undefined;
  if (input.records.length > 0) return undefined;
  const tool =
    input.lastWriteTool === undefined ? "" : `（${input.lastWriteTool}）`;
  return (
    `[flow-track] 本轮已调用写类工具${tool}, 但没有任何流程记录。` +
    "标准流程要求：先在 BACKLOG 登记条目、建追踪文档，或用 flow_record 记录本次推进；" +
    "小改动走快速流程时也请显式说明。本条只提示, 不拦截工具调用。"
  );
}

/** 最近一条记录的摘要行。 */
export function renderLastRecord(
  record: FlowRecord | undefined,
): string | undefined {
  if (record === undefined) return undefined;
  const body = record.body.trim();
  const excerpt =
    body.length === 0
      ? ""
      : `：${body.length > 120 ? `${body.slice(0, 120)}…` : body}`;
  return `最近记录：${record.slug}@${record.stage} 状态 ${record.status}${excerpt}`;
}

/** 组装注入正文；两类内容都没有 → undefined。 */
export function decideText(input: DecideInput): string | undefined {
  const parts: string[] = [];
  const compliance = renderCompliance(input);
  if (compliance !== undefined) parts.push(compliance);
  const lastRecord = renderLastRecord(input.records.at(-1));
  if (lastRecord !== undefined) parts.push(lastRecord);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}
