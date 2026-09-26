// src/app/components/ApprovalPrompt.ts — 审批弹窗渲染（纯函数）
//
// 以文本面板呈现审批请求：标题（类型标识 `[审批]`，BACKLOG 3.2.2）+ 说明
// （换行适配）；按键提示见 layout/hints.ts（底部提示区按状态显示），面板内
// 不再内嵌键位。
// 描述窗（BACKLOG 3.2.1）：prompt 折行后按 state.approvalScroll 逐行滚动，
// 不再硬截断——长草稿可用 ↑/↓ 查看全文。
// 输出恰好 height 行。

import type { FrameRow } from "../../renderer/index.ts";
import type { ApprovalItem } from "../adapter/dsh.ts";
import type { Box } from "../layout/box.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";
import { panelTitle, panelExplanation } from "../layout/panel.ts";
import { fillBoxTree } from "../layout/fill.ts";

/** 审批标题行文案（类型标识 BACKLOG 3.2.2；plan-review 之外的审批入口仅此一个） */
const APPROVAL_TITLE = " △ [审批] 等待审批 "; // 状态标记用推荐符号 △（BACKLOG 3.2.9）

/** prompt 折行结果（渲染与滚动上界共用的单一来源） */
function approvalLines(approval: ApprovalItem, width: number): string[] {
  // 与问答面板同口径：右侧只留 1 列（BACKLOG 3.2.8 修订）
  const avail = Math.max(4, width - 2);
  const lines: string[] = [];
  for (const part of approval.prompt.split("\n")) {
    if (part === "") continue;
    lines.push(...wrapByWidth(part, avail));
  }
  return lines;
}

/** 描述窗滚动上界（App 按键时算 max 进 action：state 层不知道折行宽度） */
export function maxApprovalScroll(
  approval: ApprovalItem,
  height: number,
  width: number,
): number {
  const maxBody = Math.max(0, height - 1);
  return Math.max(0, approvalLines(approval, width).length - maxBody);
}

/**
 * 审批面板 Box 生成器（TUI/docs/DESIGN.md §7 / SPEC.md §7）：输出整棵 activity
 * 内容树替换，由 fill 统一摊平。叶子用 styled/text 段序（不做 markdown
 * 解析，避免 `[y]` 等被误解析）；body 在 build 内按 avail=width-2
 * 预折行再逐行产叶子；Box 声明显式高度使 fill 补白到恰好 height 行。
 * 草稿超出窗口时，body 左侧 1 列画滚动条（轨道 + 滑块，BACKLOG 3.2.8 修订）。
 */
export function buildApprovalBox(
  approval: ApprovalItem,
  height: number,
  width: number,
  scroll = 0,
): Box {
  const maxBody = Math.max(0, height - 1); // 只剩标题行（按键提示在底部提示区）
  const lines = approvalLines(approval, width);
  // 描述窗起点：按内容行数与窗口高 clamp（用户驱动滚动，BACKLOG 3.2.1）
  const start = Math.max(
    0,
    Math.min(scroll, Math.max(0, lines.length - maxBody)),
  );
  const body = lines.slice(start, start + maxBody);
  // 描述窗左侧 1 列 = 滚动条（BACKLOG 3.2.8 修订）：轨道 `│`（border 灰）+ 滑块 `┃`（黄），
  // 滑块长度按「可见 / 总行数」比例（至少 1 行）、位置按当前偏移比例；审批面板无焦点切换，
  // 滑块恒亮色。内容不足一屏时保持原 ` 文本` 形态（不画滚动条）。
  const scrolled = lines.length > maxBody;
  const thumbLen = scrolled
    ? Math.max(1, Math.round((maxBody * maxBody) / lines.length))
    : maxBody;
  const thumbPos = scrolled
    ? Math.round(
        (start * (maxBody - thumbLen)) / Math.max(1, lines.length - maxBody),
      )
    : 0;
  // 标题行（panelTitle 原语，非 bold 黄）+ body 叶子（panelExplanation，
  // 已预折行 wrap:false 保序；不足 maxBody 补空行对齐现状恒 maxBody 行）
  const title = panelTitle(APPROVAL_TITLE, {
    style: { fg: "yellow" },
    bold: false,
  });
  const bodyLeaves = Array.from({ length: maxBody }, (_, i) => {
    const text = body[i] ?? "";
    if (!scrolled) return panelExplanation(` ${text}`);
    const onThumb = i >= thumbPos && i < thumbPos + thumbLen;
    return styled(
      [
        seg(onThumb ? "┃" : "│", { fg: onThumb ? "yellow" : "border" }),
        seg(text),
      ],
      { wrap: false },
    );
  });
  // 按键提示不在面板内（统一由底部提示区显示，见 layout/hints.ts）
  return v([title, ...bodyLeaves], {
    height: { mode: "fixed", rows: height },
  });
}

export function renderApprovalPrompt(
  approval: ApprovalItem,
  height: number,
  width: number,
  scroll = 0,
): FrameRow[] {
  // 薄包装：单一数据源 buildApprovalBox → fillBoxTree
  return fillBoxTree(
    buildApprovalBox(approval, height, width, scroll),
    height,
    width,
    "dark" as never,
  );
}

/** 按列适配宽度做简单换行（与 layout.wrapLine 语义一致，避免循环依赖） */
function wrapByWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = chrW(ch);
    if (curW > 0 && curW + w > width) {
      rows.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  rows.push(cur);
  return rows;
}

function chrW(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x2fffd)
  ) {
    return 2;
  }
  return 1;
}
