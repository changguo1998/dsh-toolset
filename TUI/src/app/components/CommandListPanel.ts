// src/app/components/CommandListPanel.ts — 共享列表面板渲染（/skills、/agents、/tools；纯函数）
//
// 输出恰 height 行，渲染于**活动区窗口**（见 COMMANDS-SPEC.md §4：面板由
// layout.buildActivePanelBox 选型，用活动区高度与内容宽度构建）。
// 单一 buildCommandListPanelBox 供三个 kind 复用（不复制 N 套 state/reducer/渲染）：
//   - 首行标题（青）+ 计数 + 右侧按键提示（灰，按剩余宽截断）
//   - 行 = `> ` 高亮前缀 + 状态符号（可选）+ 主文本（— 副文本）
//   - 占位态：数据错误（红）> 加载中（灰）> 空列表（灰），均输出恰 height 行
// 高亮行恒在可见窗口内（窗口随 index 平移），超宽 truncateToWidth（不切半个 CJK）。

import type { FrameRow } from "../../renderer/index.ts";
import { fillBoxTree } from "../layout/fill.ts";
import type { ColorName } from "../../renderer/theme.ts";
import { truncateToWidth } from "../layout.ts";
import type { Box } from "../layout/box.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";
import type { CommandPanelKind } from "../adapter/dsh.ts";
import { statusMark } from "./JobsPanel.ts";
import type { CommandPanelState } from "../state.ts";

/** kind → 面板标题（中文名词） */
const PANEL_TITLES: Record<CommandPanelKind, string> = {
  skills: "技能",
  agents: "子代理",
  tools: "工具",
  task: "任务",
  guard: "守卫",
  loop: "循环",
  workflows: "工作流",
  search: "搜索结果",
};

/** kind → 空态占位文本 */
const EMPTY_TEXTS: Record<CommandPanelKind, string> = {
  skills: "（无技能）",
  agents: "（无子代理）",
  tools: "（无工具）",
  task: "（无任务）",
  guard: "（无记录）",
  loop: "（无循环）",
  workflows: "（无运行中工作流）",
  search: "（无结果）",
};

/**
 * 共享列表面板 Box 生成器：标题 + 计数（青）头部行、行窗口（高亮 `> ` + 可选
 * 符号 + 主/副文本）、占位态。按键提示不在面板内——统一由底部提示区显示
 * （见 `layout/hints.ts` 的 `commandPanelHint`）。
 * 叶子 styled wrap:false；滚动窗口与截断算法保留在 build 内。
 */
export function buildCommandListPanelBox(
  panel: CommandPanelState,
  height: number,
  width: number,
): Box {
  const rows = Math.max(1, height);
  const leaves = [];

  // 首行：标题 + 计数（青）；按键提示统一由底部提示区显示（见 layout/hints.ts）
  const header = `${PANEL_TITLES[panel.kind]}（${panel.rows.length}）`;
  const headerVisible = truncateToWidth(header, width);
  leaves.push(
    styled([{ text: headerVisible, style: { fg: "cyan" as ColorName } }], {
      wrap: false,
    }),
  );

  // 占位态优先级：数据错误 > 加载中 > 空列表（三者都输出恰 height 行）
  let placeholder: { text: string; fg: ColorName } | null = null;
  if (panel.error !== undefined) {
    placeholder = { text: `读取失败：${panel.error}`, fg: "red" };
  } else if (panel.loading) {
    placeholder = { text: "加载中…", fg: "gray" };
  } else if (panel.rows.length === 0) {
    placeholder = { text: EMPTY_TEXTS[panel.kind], fg: "gray" };
  }
  if (placeholder) {
    leaves.push(
      styled(
        [seg(truncateToWidth(placeholder.text, width), { fg: placeholder.fg })],
        { wrap: false },
      ),
    );
    while (leaves.length < rows) leaves.push(styled([seg("")]));
    return v(leaves);
  }

  // 行窗口：高亮行恒在窗口内（窗口随 index 平移）
  const bodyRows = Math.max(1, rows - leaves.length);
  const clamped = Math.max(0, Math.min(panel.index, panel.rows.length - 1));
  const windowStart = Math.max(
    0,
    Math.min(clamped, panel.rows.length - bodyRows),
  );
  for (
    let i = windowStart;
    i < panel.rows.length && leaves.length < rows;
    i++
  ) {
    const row = panel.rows[i]!;
    // 状态语义 → 符号与颜色（口径同 JobsPanel.statusMark）；无 status 时整行默认前景
    const mark = row.status ? statusMark(row.status) : undefined;
    const sym = mark ? `${mark.symbol} ` : "";
    const detail = row.detail && row.detail !== "" ? ` — ${row.detail}` : "";
    const line = `${i === clamped ? "> " : "  "}${sym}${row.title}${detail}`;
    const text = truncateToWidth(line, width);
    leaves.push(
      mark?.color
        ? styled([seg(text, { fg: mark.color })], { wrap: false })
        : styled([seg(text)], { wrap: false }),
    );
  }
  while (leaves.length < rows) leaves.push(styled([seg("")]));
  return v(leaves);
}

/** 薄包装：单一数据源 buildCommandListPanelBox → fillBoxTree（与 JobsPanel 同风格） */
export function renderCommandListPanel(
  panel: CommandPanelState,
  height: number,
  width: number,
): FrameRow[] {
  return fillBoxTree(
    buildCommandListPanelBox(panel, height, width),
    height,
    width,
    "dark" as never,
  );
}
