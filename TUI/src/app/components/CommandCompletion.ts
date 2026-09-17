// src/app/components/CommandCompletion.ts — 输入补全候选面板（活动区窗口）
//
// 输入仍处于首个命令 token 时，把匹配的命令候选显示在流输出（活动区）窗口：
// 标题行 + 候选行（焦点行 `> /name  desc` 黄色，默认高亮最匹配项）。
// 候选尽可能铺满活动区可视行（面板不放按键提示——键位统一放在输入区下方的
// 按键提示区，见 layout.ts 的 COMPLETION_HINT_LINE）。
// 判定与排序在 commands.ts 的 completeCommandInput（纯函数），本组件只渲染。
// 输出恰 height 行：标题 + (height-1) 行候选（**超出的候选直接丢弃，不滚动**；
// 焦点导航同口径由 App.completionVisibleRows() 限制在可视范围内）。
//
// 宽度契约：每行都必须 ≤ width（显示列）。行内容先按显示宽截断（truncateToWidth
// 会剥 ANSI 计宽、不切半个 CJK），再着色——着色后宽度计算会被转义序列打乱，
// 一旦超宽会把活动区右缘框线挤偏并让终端折行。

import type { FrameRow } from "../../renderer/index.ts";
import type { ThemeId } from "../../renderer/theme.ts";
import { truncateToWidth } from "../layout.ts";
import type { CommandCandidate } from "../commands.ts";
import type { Box } from "../layout/box.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";
import { fillBoxTree } from "../layout/fill.ts";

export interface CommandCompletionView {
  /** 候选项 + 焦点索引（0 = 最匹配默认项） */
  completion: { items: readonly CommandCandidate[]; index: number };
  height: number;
  width: number;
  themeId: ThemeId;
}

/**
 * 输入补全候选面板 Box 生成器（DESIGN.md §7 / SPEC.md §7）：标题行（命令名
 * 蓝）+ 候选行（焦点`>`黄，超宽截断后着色）；超出的候选丢弃、不足补空行。
 * 叶子 styled wrap:false。
 */
export function buildCommandCompletionBox(view: CommandCompletionView): Box {
  const { completion, height } = view;
  const width = Math.max(1, view.width);

  const title = styled(
    [seg(truncateToWidth(" /命令补全", width), { fg: "blue" as const })],
    { wrap: false },
  );
  const leaves = [title];
  for (let i = 0; i < completion.items.length && leaves.length < height; i++) {
    const item = completion.items[i]!;
    const focused = i === completion.index;
    const text = truncateToWidth(
      ` ${focused ? ">" : " "} /${item.name}${item.desc ? `  ${item.desc}` : ""}`,
      width,
    );
    leaves.push(
      focused
        ? styled([seg(text, { fg: "yellow" as const })], { wrap: false })
        : styled([seg(text)], { wrap: false }),
    );
  }
  while (leaves.length < height) leaves.push(styled([seg("")]));
  return v(leaves.map((l) => l));
}

export function renderCommandCompletion(
  view: CommandCompletionView,
): FrameRow[] {
  // 薄包装：单一数据源 buildCommandCompletionBox → fillBoxTree
  return fillBoxTree(
    buildCommandCompletionBox(view),
    view.height,
    view.width,
    view.themeId,
  );
}
