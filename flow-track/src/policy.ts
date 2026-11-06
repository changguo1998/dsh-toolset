/**
 * flow-track/src/policy.ts — 阶段顺序策略（纯函数, 零 IO）。
 *
 * 一个 slug 的时间线只允许两种写入:
 * - **更新当前阶段**: 写入与当前阶段相同的阶段名 → 替换该阶段旧记录;
 * - **新增下一阶段**: 写入当前阶段的下一个阶段 → 追加。
 *
 * 跳过阶段、倒回阶段一律拒绝; 倒回走 `decideRollback`（回到某阶段并清后续）。
 * `-` 表示整体推进, 只作备注, 不参与当前阶段推导。
 */

import { STAGES } from "./stages.ts";
import type { FlowRecord } from "./store.ts";

/** 八阶段名（顺序即推进顺序）。 */
export const STAGE_NAMES: readonly string[] = STAGES.map((stage) => stage.name);

/** 整体推进用的备注阶段名。 */
export const WHOLE_STAGE = "-";

/** 阶段名在八阶段里的下标（不在表内返回 -1）。 */
export function stageIndex(stage: string): number {
  return STAGE_NAMES.indexOf(stage);
}

/** 时间线上最新的「真实阶段」记录（跳过 `-` 备注）。 */
export function latestStageRecord(
  records: readonly FlowRecord[],
): FlowRecord | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record !== undefined && record.stage !== WHOLE_STAGE) return record;
  }
  return undefined;
}

/** 最后一个阶段名（收尾）。 */
const LAST_STAGE = STAGE_NAMES[STAGE_NAMES.length - 1] ?? "收尾";

/**
 * 是否还有未完成的流程: 任一 slug 最新的真实阶段不是「收尾」即算活跃。
 *
 * `records` 按时间正序（`FlowStore.list` 的口径）；`-` 备注不参与阶段推导。
 */
export function hasActiveFlow(records: readonly FlowRecord[]): boolean {
  const latest = new Map<string, string>();
  for (const record of records) {
    if (record.stage === WHOLE_STAGE) continue;
    latest.set(record.slug, record.stage);
  }
  for (const stage of latest.values()) {
    if (stage !== LAST_STAGE) return true;
  }
  return false;
}

/** 写入判定。 */
export type RecordPolicy =
  | { kind: "write"; replace: boolean }
  | {
      kind: "reject";
      error:
        | "first_stage"
        | "invalid_stage"
        | "skip_stage"
        | "rollback_needed"
        | "unknown_current";
      message: string;
    };

/**
 * 判定一次 `flow_record` 是否允许, 以及是否要替换当前阶段。
 *
 * `records` 是该 slug 的时间线（时间正序）。
 */
export function decideRecord(
  records: readonly FlowRecord[],
  stage: string,
): RecordPolicy {
  const last = latestStageRecord(records);
  if (stage === WHOLE_STAGE) {
    if (last === undefined) {
      return {
        kind: "reject",
        error: "first_stage",
        message: `首条记录必须是「${STAGE_NAMES[0]}」；- 只能作已有阶段的备注`,
      };
    }
    return { kind: "write", replace: false };
  }
  const index = stageIndex(stage);
  if (index < 0) {
    return {
      kind: "reject",
      error: "invalid_stage",
      message: `阶段名只能是 ${STAGE_NAMES.join(" / ")} 或 -`,
    };
  }
  if (last === undefined) {
    if (index === 0) return { kind: "write", replace: false };
    return {
      kind: "reject",
      error: "first_stage",
      message: `首条记录必须是「${STAGE_NAMES[0]}」, 不能从「${stage}」开始`,
    };
  }
  const current = stageIndex(last.stage);
  if (current < 0) {
    return {
      kind: "reject",
      error: "unknown_current",
      message: `最新记录的阶段「${last.stage}」不在八阶段内, 先用 flow_remove 清掉它再写`,
    };
  }
  if (index === current) return { kind: "write", replace: true };
  if (index === current + 1) return { kind: "write", replace: false };
  if (index > current + 1) {
    const next = STAGE_NAMES[current + 1] ?? "（已是最后阶段）";
    return {
      kind: "reject",
      error: "skip_stage",
      message: `不能跳过阶段: 当前是「${last.stage}」, 下一步只能是「${next}」`,
    };
  }
  return {
    kind: "reject",
    error: "rollback_needed",
    message: `不能直接回到「${stage}」: 回退要用 flow_rollback（会清掉「${last.stage}」及之后的记录）`,
  };
}

/** 回退判定。 */
export type RollbackPolicy =
  | { kind: "clear"; ids: number[] }
  | {
      kind: "reject";
      error:
        "invalid_stage" | "no_records" | "unknown_current" | "not_backward";
      message: string;
    };

/**
 * 判定一次 `flow_rollback`: 目标阶段必须早于当前阶段。
 *
 * 清掉的部分 = 阶段序大于目标的记录 + 全部 `-` 备注; 目标阶段的记录保留。
 */
export function decideRollback(
  records: readonly FlowRecord[],
  stage: string,
): RollbackPolicy {
  const target = stageIndex(stage);
  if (target < 0) {
    return {
      kind: "reject",
      error: "invalid_stage",
      message: `回退目标只能是 ${STAGE_NAMES.join(" / ")}`,
    };
  }
  const last = latestStageRecord(records);
  if (last === undefined) {
    return {
      kind: "reject",
      error: "no_records",
      message: "该任务还没有流程记录, 无需回退",
    };
  }
  const current = stageIndex(last.stage);
  if (current < 0) {
    return {
      kind: "reject",
      error: "unknown_current",
      message: `最新记录的阶段「${last.stage}」不在八阶段内, 先用 flow_remove 清掉它`,
    };
  }
  if (target >= current) {
    return {
      kind: "reject",
      error: "not_backward",
      message: `目标「${stage}」不早于当前阶段「${last.stage}」: 推进或更新用 flow_record`,
    };
  }
  const ids: number[] = [];
  for (const record of records) {
    if (record.stage === WHOLE_STAGE) {
      ids.push(record.id);
      continue;
    }
    const index = stageIndex(record.stage);
    if (index > target) ids.push(record.id);
  }
  return { kind: "clear", ids };
}
