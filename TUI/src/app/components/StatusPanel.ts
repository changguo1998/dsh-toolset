// src/app/components/StatusPanel.ts — 通用状态选项面板（/policy /permission /preset）
//
// 以文本面板呈现一组状态选项（活动区窗口，与审批/问答/模型选择同区域）：
// 标题行 + 选项列表 + 操作提示行。↑/↓ 移动焦点（>），空格预选（*，再按取消），
// Enter 提交预选（无预选回退焦点行）并关闭，Esc 取消。
// 输出恰 height 行：标题 + 最多 (height-2) 行选项（超出时窗口跟随焦点滚动）+ 操作提示。

import type { FrameRow } from "../../renderer/index.ts";
import type { ThemeId } from "../../renderer/theme.ts";
import type { StatusPanelState } from "../state.ts";
import type { Box } from "../layout/box.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";

/**
 * 状态选项面板 Box 生成器（DESIGN.md §7 / SPEC.md §7）：标题行（命令名蓝
 * + 当前生效值）+ 选项列表（焦点`>`黄 / 预选`*`绿）+ 操作提示。选项滚动
 * 窗口算法保留在 build 内（跟随焦点滚动）；叶子 styled wrap:false 精确行长。
 */
export function buildStatusPanelBox(
  panel: StatusPanelState,
  height: number,
  width: number,
): Box {
  const current = panel.selected ?? panel.options[panel.index]?.id ?? "";
  // 标题行：命令名（蓝）+ 当前生效值（保留现状 replace 行为）
  const titleSegs: { text: string; style?: import("../../renderer/screen.ts").FrameStyle }[] = [
    { text: " " },
    { text: panel.title.replace("（当前：", ""), style: { fg: "blue" as const } },
    ...(current === ""
      ? []
      : [{ text: `  ·  当前：${current}` }]),
  ];
  const titleRow = styled(titleSegs, { wrap: false });

  // 选项行：焦点 > 黄、预选 * 绿、未选默认
  const rows = [];
  for (let i = 0; i < panel.options.length; i++) {
    const opt = panel.options[i]!;
    if (opt === undefined) break;
    const f = i === panel.index;
    const sel = panel.selected === opt.id;
    const mark = sel ? "*" : " ";
    const cursor = f ? ">" : " ";
    const line =
      " " + cursor + mark + " " + (opt.label ?? opt.id) + (opt.desc ? " " + opt.desc : "");
    if (f) rows.push(styled([seg(line, { fg: "yellow" as const })], { wrap: false }));
    else if (sel)
      rows.push(styled([seg(line, { fg: "green" as const })], { wrap: false }));
    else rows.push(styled([seg(line)], { wrap: false }));
  }

  // 操作提示行（末行）
  const hint =
    "[Enter]提交 · [空格]预选" +
    (panel.options.length > 1 ? " · [↑/↓]选项" : "") +
    " · [Esc]取消";

  // 组装：标题 + 窗口内选项（跟随焦点滚动；不足补空行）+ 操作提示
  const maxBody = Math.max(0, height - 2);
  let window: typeof rows = rows;
  if (rows.length > maxBody) {
    let start = panel.index - Math.floor(maxBody / 2);
    start = Math.max(0, Math.min(start, rows.length - maxBody));
    window = rows.slice(start, start + maxBody);
  }
  const body = Array.from({ length: maxBody }, (_, i) => window[i] ?? styled([seg("")]));
  // 提示行与现状一致：首尾空格后按 width 截断（一字符串一行，右缘装饰补齐）
  const hintRow = styled([seg((" " + hint + " ").slice(0, Math.max(1, width)))], {
    wrap: false,
  });
  return v([titleRow, ...body, hintRow]);
}

export interface StatusPanelView {
  panel: StatusPanelState;
  height: number;
  width: number;
  themeId: ThemeId;
}

export function renderStatusPanel(view: StatusPanelView): FrameRow[] {
  const { panel, height } = view;
  const out: FrameRow[] = [];

  // 标题行：命令名（蓝）+ 当前生效值
  const current = panel.selected ?? panel.options[panel.index]?.id ?? "";
  out.push({
    segments: [
      { text: " " },
      { text: panel.title.replace("（当前：", ""), style: { fg: "blue" } },
      ...(current === ""
        ? []
        : [{ text: "  ·  当前：" + current }]),
    ],
  });

  // 选项行（焦点行 > 黄，预选行 * 绿，未选默认）
  const rows: FrameRow[] = [];
  for (let i = 0; i < panel.options.length; i++) {
    const opt = panel.options[i]!;
    const f = i === panel.index;
    const sel = panel.selected === opt.id;
    const mark = sel ? "*" : " ";
    const cursor = f ? ">" : " ";
    const text = " " + cursor + mark + " " + (opt.label ?? opt.id) + (opt.desc ? " " + opt.desc : "");
    if (f) rows.push({ segments: [{ text, style: { fg: "yellow" } }] });
    else if (sel) rows.push({ segments: [{ text, style: { fg: "green" } }] });
    else rows.push({ segments: [{ text }] });
  }

  // 操作提示行（末行）
  const hint =
    "[Enter]提交 · [空格]预选" +
    (panel.options.length > 1 ? " · [↑/↓]选项" : "") +
    " · [Esc]取消";

  // 组装：标题 + 窗口内选项（跟随焦点滚动；不足补空行）+ 操作提示
  const maxBody = Math.max(0, height - 2);
  if (rows.length <= maxBody) {
    out.push(...rows);
    while (out.length < height - 1) out.push({ segments: [{ text: "" }] });
  } else {
    // 滚动窗口：焦点行尽量居中，超出 clamp
    let start = panel.index - Math.floor(maxBody / 2);
    start = Math.max(0, Math.min(start, rows.length - maxBody));
    out.push(...rows.slice(start, start + maxBody));
  }
  out.push({
    segments: [{ text: (" " + hint + " ").padEnd(Math.max(1, view.width)) }],
  });
  return out.map((r) => ({
    segments: r.segments.map((s) => ({
      ...s,
      text: s.text.slice(0, Math.max(1, view.width)),
    })),
  }));
}
