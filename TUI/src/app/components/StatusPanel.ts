// src/app/components/StatusPanel.ts — 通用状态选项面板（/policy /permission /preset）
//
// 以文本面板呈现一组状态选项（活动区窗口，与审批/问答/模型选择同区域）：
// 标题行 + 选项列表 + 操作提示行。↑/↓ 移动焦点（>），空格预选（*，再按取消），
// Enter 提交预选（无预选回退焦点行）并关闭，Esc 取消。
// 输出恰 height 行：标题 + 最多 (height-2) 行选项（超出时窗口跟随焦点滚动）+ 操作提示。

import type { RenderLine } from "../../renderer/index.ts";
import { colorFor, type ThemeId } from "../../renderer/theme.ts";
import type { StatusPanelState } from "../state.ts";

export interface StatusPanelView {
  panel: StatusPanelState;
  height: number;
  width: number;
  themeId: ThemeId;
}

export function renderStatusPanel(view: StatusPanelView): RenderLine[] {
  const { panel, height, themeId } = view;
  const out: RenderLine[] = [];
  const curColor = colorFor(themeId, "yellow");
  const selColor = colorFor(themeId, "green");

  // 标题行：命令名（蓝）+ 当前生效值
  const current = panel.selected ?? panel.options[panel.index]?.id ?? "";
  out.push({
    text:
      " " +
      colorFor(themeId, "blue")(panel.title.replace("（当前：", "")) +
      (current === "" ? "" : "  ·  当前：" + current),
  });

  // 选项行（焦点行 > 黄，预选行 * 绿，未选默认）
  const rows: RenderLine[] = [];
  for (let i = 0; i < panel.options.length; i++) {
    const opt = panel.options[i]!;
    const f = i === panel.index;
    const sel = panel.selected === opt.id;
    const mark = sel ? "*" : " ";
    const cursor = f ? ">" : " ";
    const text = " " + cursor + mark + " " + (opt.label ?? opt.id) + (opt.desc ? " " + opt.desc : "");
    if (f) rows.push({ text: curColor(text) });
    else if (sel) rows.push({ text: selColor(text) });
    else rows.push({ text });
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
    while (out.length < height - 1) out.push({ text: "" });
  } else {
    // 滚动窗口：焦点行尽量居中，超出 clamp
    let start = panel.index - Math.floor(maxBody / 2);
    start = Math.max(0, Math.min(start, rows.length - maxBody));
    out.push(...rows.slice(start, start + maxBody));
  }
  out.push({
    text: (" " + hint + " ").padEnd(Math.max(1, view.width)),
  });
  return out.map((r) => ({ text: r.text.slice(0, Math.max(1, view.width)) }));
}
