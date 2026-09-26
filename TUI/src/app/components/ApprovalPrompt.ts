// src/app/components/ApprovalPrompt.ts — 审批弹窗渲染（纯函数）
//
// 以文本面板呈现审批请求：标题（类型标识 `[审批]`，BACKLOG 3.2.2）+ 草稿
// （描述窗，换行适配 / 滚动）；按键提示见 layout/hints.ts（底部提示区按状态显示），
// 面板内不内嵌键位。
// 两窗（BACKLOG 3.2.1 / 3.2.11 规则）：描述窗放审批草稿（prompt 折行，按
// state.approvalScroll 逐行滚动，草稿超屏时左侧画滚动条），选项窗放
// 「批准 / 拒绝」两项（BACKLOG 3.2.4），带编号（3.2.6）；拒绝项行尾显示剩余
// 秒数倒计时（BACKLOG 3.2.5）。
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

/** 审批选项（BACKLOG 3.2.4）：固定两项，顺序与编号 1/2、`y`/`n` 直答一致 */
export const APPROVAL_OPTIONS = ["批准", "拒绝"] as const;

/** 审批面板视图参数（焦点 / 倒计时；缺省值保持旧调用可编译） */
export interface ApprovalView {
  /** 选项焦点（BACKLOG 3.2.4） */
  focus?: "approve" | "reject";
  /** 超时时刻（epoch ms，BACKLOG 3.2.5；null/缺省 = 不显示倒计时） */
  deadline?: number | null;
  /** 当前时刻（缺省 Date.now()；测试可注入固定值） */
  now?: number;
  /** 当前焦点窗（BACKLOG 3.3.4，与问答面板同构）：desc=草稿 / options=选项；缺省 options */
  window?: "desc" | "options";
}

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

/** 描述窗可见行上限（面板体 2/3，BACKLOG 3.2.11 规则） */
function approvalDescMaxRows(maxBody: number): number {
  return Math.max(1, Math.floor((maxBody * 2) / 3));
}

/** 描述窗滚动上界（App 按键时算 max 进 action：state 层不知道折行宽度） */
export function maxApprovalScroll(
  approval: ApprovalItem,
  height: number,
  width: number,
): number {
  const maxBody = Math.max(0, height - 1);
  return Math.max(
    0,
    approvalLines(approval, width).length - approvalDescMaxRows(maxBody),
  );
}

/**
 * 审批面板 Box 生成器（TUI/docs/DESIGN.md §7 / SPEC.md §7）：输出整棵 activity
 * 内容树替换，由 fill 统一摊平。叶子用 styled/text 段序（不做 markdown
 * 解析，避免 `[y]` 等被误解析）；草稿在 build 内按 avail=width-2 预折行再逐行
 * 产叶子；Box 声明显式高度使 fill 补白到恰好 height 行。
 */
export function buildApprovalBox(
  approval: ApprovalItem,
  height: number,
  width: number,
  scroll = 0,
  view: ApprovalView = {},
): Box {
  const maxBody = Math.max(0, height - 1); // 只剩标题行（按键提示在底部提示区）
  const lines = approvalLines(approval, width);
  // 两窗分配（BACKLOG 3.2.11 规则）：描述窗上限 = 面板体 2/3，选项窗吃剩余行
  const bodyRows = maxBody;
  const descMaxRows = approvalDescMaxRows(bodyRows);
  const maxDescScroll = Math.max(0, lines.length - descMaxRows);
  const start = Math.max(0, Math.min(scroll, maxDescScroll));
  const descVisible = Math.min(
    descMaxRows,
    Math.max(0, lines.length - start),
    bodyRows,
  );
  const desc = lines.slice(start, start + descVisible);
  const optRows = Math.max(0, bodyRows - descVisible);
  // 描述窗左侧 1 列 = 滚动条（BACKLOG 3.2.8 修订）：轨道 `│`（border 灰）+ 滑块 `┃`（黄）；
  // 审批面板没有「描述窗焦点」概念，滑块恒亮色。内容不足一屏时保持原 ` 文本` 形态。
  const scrolled = lines.length > descVisible;
  const thumbLen = scrolled
    ? Math.max(1, Math.round((descVisible * descVisible) / lines.length))
    : descVisible;
  const thumbPos = scrolled
    ? Math.round(
        (start * (descVisible - thumbLen)) /
          Math.max(1, lines.length - descVisible),
      )
    : 0;
  // 焦点窗（3.3.4）：描述窗聚焦时左侧列着黄（可滚动=滑块、不滚动=整列焦点条），
  // 选项窗聚焦时左侧列转灰、由选项光标行着黄 —— 全屏只有一处焦点黄（沿用 3.2.8 口径）
  const descFocused = view.window === "desc";
  const descLeaves = desc.map((text, i) => {
    if (!scrolled) {
      if (!descFocused) return panelExplanation(` ${text}`);
      return styled([seg("┃", { fg: "yellow" }), seg(text)], { wrap: false });
    }
    const onThumb = i >= thumbPos && i < thumbPos + thumbLen;
    return styled(
      [
        seg(onThumb ? "┃" : "│", {
          fg: onThumb ? (descFocused ? "yellow" : "border") : "border",
        }),
        seg(text),
      ],
      { wrap: false },
    );
  });
  // 选项窗（3.2.4 / 3.2.6）：两项固定「批准 / 拒绝」，编号与数字直答一致；拒绝项行尾
  // 带剩余秒数倒计时（3.2.5——由宿主侧超时裁定，倒计时只做提示）。
  const focus = view.focus ?? "approve";
  const optionFocused = (view.window ?? "options") === "options";
  const remain =
    view.deadline == null
      ? null
      : Math.max(
          0,
          Math.ceil((view.deadline - (view.now ?? Date.now())) / 1000),
        );
  const optionLeaves = APPROVAL_OPTIONS.slice(0, optRows).map((label, i) => {
    const selected = (i === 0 ? "approve" : "reject") === focus;
    const tail = i === 1 && remain !== null ? ` (${remain}s)` : "";
    return styled(
      [
        seg(
          // 与问答面板同格式（BACKLOG 3.2.12）：` ${光标} ${编号}. ${内容}`（标记位留空）；
          // 焦点在描述窗时选项光标降色（3.3.4 / 3.2.8 口径）
          ` ${selected ? ">" : " "}  ${i + 1}. `,
          selected && optionFocused ? { fg: "yellow" } : undefined,
        ),
        seg(label + tail),
      ],
      { wrap: false },
    );
  });
  const padding = Math.max(0, optRows - optionLeaves.length);
  // 标题行（panelTitle 原语，非 bold 黄）+ 两窗叶子（不足由 fill 补白到恰好 height 行）
  const title = panelTitle(APPROVAL_TITLE, {
    style: { fg: "yellow" },
    bold: false,
  });
  return v(
    [
      title,
      ...descLeaves,
      ...optionLeaves,
      ...Array.from({ length: padding }, () => panelExplanation("")),
    ],
    { height: { mode: "fixed", rows: height } },
  );
}

export function renderApprovalPrompt(
  approval: ApprovalItem,
  height: number,
  width: number,
  scroll = 0,
  view: ApprovalView = {},
): FrameRow[] {
  // 薄包装：单一数据源 buildApprovalBox → fillBoxTree
  return fillBoxTree(
    buildApprovalBox(approval, height, width, scroll, view),
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
