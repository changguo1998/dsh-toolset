// TUI/src/app/scroll-helpers.ts — 焦点面板行/整页滚动的 action 映射

import type { FrameGeometry } from "./layout.ts";
import type { StateAction } from "./state.ts";

/**
 * 焦点面板行滚动 action 映射：activity 偏移语义=距底部（上滚=+），
 * status 偏移语义=距顶部（上滚=-），方向不可混用。
 *
 * `delta` = 位移行数（正 = 上滚）：裸 ↑/↓ 传 1，Ctrl+↑/↓ 传半屏
 * （`dialogueHalfPage(activityH)`，与会话区同款快速翻页）。
 *
 * 会话区不在其中：它按「段键 + 段内行」定位，位移在 App 用本帧段表换算
 * （见 `App.scrollDialogueBy`）。
 */
export function focusedLineScroll(
  panel: "activity" | "status",
  delta: number, // 行数：正=上, 负=下
  max?: PaneScrollMax,
): StateAction {
  if (panel === "activity") {
    return {
      type: "activity-scroll",
      delta,
      ...(max ? { max: max.activity } : {}),
    };
  }
  return { type: "status-column-scroll", delta: -delta };
}

/** 焦点面板整页滚动 action 映射（页 = 该面板当前可视行数；会话区同上） */
export function focusedPageScroll(
  panel: "activity" | "status",
  dir: 1 | -1, // 1=上一页, -1=下一页
  page: FrameGeometry,
  max?: PaneScrollMax,
): StateAction {
  if (panel === "activity") {
    return {
      type: "activity-scroll",
      delta: dir * page.activityH,
      ...(max ? { max: max.activity } : {}),
    };
  }
  return { type: "status-column-scroll", delta: -dir * page.contentTopH };
}

/** 两 pane 的可滚动上限（行单位；App 经 paneMaxes() 取得，见 FrameScrollReport） */
export interface PaneScrollMax {
  dialogue: number;
  activity: number;
}
