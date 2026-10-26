// tests/helpers/renderBuffer.ts — 缓冲行 → 新链渲染（旧 `buildContentRows` 的替代口）
//
// 背景：内容渲染已全部迁到新流水线（§1 分节 → §7 组装”，`pipelineContent`）。仍用
// `HistoryRow[]` 造语料的测试从这里走：缓冲行先经 `sectionsFromBuffer` 重放成节缓存，
// 再交给 `pipelineContent` 产两 pane 的 `ContentRow[]`——与生产帧同一条链路。
//
// 用法：
//   const { dialogue, activity } = renderBuffer(buf, { dialogueTextW: 40 });

import { pipelineContent } from "../../src/app/layout/pipeline/frame.ts";
import { sectionsFromBuffer } from "../../src/app/layout/pipeline/replay.ts";
import type { ContentRow } from "../../src/app/layout/fill.ts";
import type { ActivitySwitches, HistoryRow } from "../../src/app/state.ts";

export interface RenderBufferOptions {
  /** 会话区可用宽（缺省 80） */
  dialogueTextW?: number;
  /** 回合区可用宽（缺省同会话区） */
  activityTextW?: number;
  /** 用户 / 助手右缘留白 */
  gutter?: number;
  /** 活动区显示档位（/verbose） */
  activityShow?: Partial<ActivitySwitches>;
  /** 活动区紧凑档位（/collapse） */
  activityCompact?: Partial<ActivitySwitches>;
  /** 按历史节重放（缺省 true = 定型内容进会话区） */
  history?: boolean;
}

/** 缓冲行 → 两 pane 的 `ContentRow[]`（新链） */
export function renderBuffer(
  lines: readonly HistoryRow[],
  options: RenderBufferOptions = {},
): { dialogue: ContentRow[]; activity: ContentRow[] } {
  const width = Math.max(1, options.dialogueTextW ?? 80);
  const activityWidth = Math.max(1, options.activityTextW ?? width);
  const state = sectionsFromBuffer(
    lines,
    options.history === true ? { history: true } : {},
  );
  const content = pipelineContent(state, {
    dialogueTextW: width,
    activityTextW: activityWidth,
    windowGroups: 1000, // 测试语料一律全量物化
    render: {
      width,
      activityWidth,
      ...(options.gutter === undefined ? {} : { gutter: options.gutter }),
      ...(options.activityShow === undefined
        ? {}
        : { activityShow: options.activityShow }),
      ...(options.activityCompact === undefined
        ? {}
        : { activityCompact: options.activityCompact }),
    },
  });
  return { dialogue: content.dialogue, activity: content.activity };
}
