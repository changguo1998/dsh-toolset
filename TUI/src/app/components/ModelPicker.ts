// src/app/components/ModelPicker.ts — /model 交互选择面板渲染（纯函数）
//
// 输出恰 height 行，**三列独立列表同屏**：provider / model / effort 三列独立
// 滚动，头部全小写。←/→ 左右切换三列焦点区（clamp 不循环；phase 0=provider，
// 1=model，2=effort），Tab 循环切换。
// 条目有两种标记：星号 `*` = 待提交选中（Enter 提交它，
// 按 space 把焦点行写入）、大于号 `>` = 当前位置指示（焦点行，临时态，
// 需按 space 确认选中）。着色：选中行绿、焦点行黄，两者同一行时绿优先（按
// space 选中后立即变色可见）。焦点列标题用 `[ ]` 方括号包裹（如
// `[ provider ]`），列表行不加边框。某列上方/下方有未显示项时，可视区
// 顶部/底部对应行显示 `...` 省略号（焦点所在行不显示省略号，保证焦点
// 恒可见）。最底行打印按键帮助：空格=选中，←/→=切换列，Tab=下一列，Enter=提交，
// Esc=取消。

import type { FrameRow } from "../../renderer/index.ts";
import type { ThemeId } from "../../renderer/theme.ts";
import type { PickerState } from "../state.ts";
import { truncateToWidth } from "../layout.ts";
import type { Box } from "../layout/box.ts";
import { fillBoxTree } from "../layout/fill.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";

export interface ModelPickerView {
  picker: PickerState;
  /** 面板可用行数（footer 高度） */
  height: number;
  /** 面板可用列宽 */
  width: number;
}

/** 视口起点：让焦点项恒在可视区内 */
function scrollStart(len: number, focus: number, rows: number): number {
  if (len <= rows || rows <= 0) return 0;
  return Math.min(Math.max(0, focus - (rows - 1)), len - rows);
}

/**
 * 行前标记：星号 `*` 表示该行已作为待提交选中（Enter 提交它），箭头
 * `>` 表示当前位置（临时态，需按 space 确认后才成为星号选中）。
 */
function markCell(isSelected: boolean, isFocusRow: boolean): string {
  if (isSelected) return "* "; // 星号 = 待提交选中（Enter 提交它）
  if (isFocusRow) return "> "; // 箭头 = 当前位置指示（仅所在列焦点区）
  return "  ";
}

/** 单个列表列：省略号（顶/底）+ 内容区渲染 */
function renderColumnCell(
  items: {
    len: number;
    at: (i: number) => string;
    matchAt?: (i: number) => string;
  },
  start: number,
  contentRows: number,
  topO: boolean,
  bottomO: boolean,
  rowIdx: number,
  listRows: number,
  phase: number,
  thisPhase: number,
  focus: number,
  selectedOf: string | undefined,
): { text: string; focus: boolean; sel: boolean } {
  if (rowIdx === 0 && topO) return { text: " ...", focus: false, sel: false };
  // 底部省略号占末数据行；仅当该行不在内容区内（空间不足时让位给内容）
  if (
    rowIdx === listRows - 1 &&
    bottomO &&
    rowIdx - (topO ? 1 : 0) - (contentRows - 1) > 0
  )
    return { text: " ...", focus: false, sel: false };
  const contentRow = rowIdx - (topO ? 1 : 0); // 顶部省略号后内容区起点
  if (contentRow < 0 || contentRow >= contentRows)
    return { text: "", focus: false, sel: false };
  const idx = start + contentRow;
  if (idx < 0 || idx >= items.len)
    return { text: "", focus: false, sel: false };
  const v = items.at(idx);
  const f = phase === thisPhase && idx === focus;
  // 选中按匹配键比较：effort 列显示 name 但选中键为 id，需显式 matchAt
  const sel = (items.matchAt ?? items.at)(idx) === selectedOf;
  return { text: markCell(sel, f) + v, focus: f, sel: sel };
}

/**
 * 模型选择面板 Box 生成器（DESIGN.md §7 / SPEC.md §7）：三列独立列表（provider/
 * model/effort）滚动窗口 + 列宽截断补空 + 选择性着色（绿优先于黄）+ 底行按键帮助。
 * 每行产 styled 多段叶子（列段 + 间隔段），叶子 wrap:false 精确行长。
 */
export function buildModelPickerBox(view: ModelPickerView): Box {
  const {
    providers,
    providerIndex,
    models,
    modelIndex,
    efforts,
    effortIndex,
    phase,
    selectedProvider,
    selectedModel,
    selectedEffort,
  } = view.picker;
  const height = Math.max(1, view.height);
  const width = Math.max(1, view.width);
  const sep = width >= 32 ? 2 : 1;
  const provW = Math.min(16, Math.max(6, Math.floor(width * 0.22)));
  const remain = Math.max(1, width - provW - sep * 2);
  const thinkW = Math.max(10, Math.floor(remain * 0.4));
  const modelW = Math.max(1, remain - thinkW);
  const widths = [provW, modelW, thinkW];

  const listRows = Math.max(1, height - 2);
  const unsupported = efforts.length === 0;
  const colContent = (len: number) =>
    len <= listRows ? listRows : Math.max(1, listRows - 2);
  const provRows = colContent(providers.length);
  const modelRows = colContent(models.length);
  const effRows = colContent(efforts.length);
  const provStart = scrollStart(providers.length, providerIndex, provRows);
  const modelStart = scrollStart(models.length, modelIndex, modelRows);
  const effStart = scrollStart(efforts.length, effortIndex, effRows);
  const topO = (start: number) => start > 0;
  const bottomO = (len: number, rows: number, start: number) =>
    start + rows < len;

  const leaves: import("../layout/box.ts").Node[] = [];
  for (let r = 0; r < height; r++) {
    let cells: { text: string; focus: boolean; sel: boolean }[] = [
      { text: "", focus: false, sel: false },
      { text: "", focus: false, sel: false },
      { text: "", focus: false, sel: false },
    ];
    if (r === 0) {
      const hdr = (t: string, isF: boolean) => (isF ? `[ ${t} ]` : ` ${t}`);
      cells = [
        { text: hdr("provider", phase === 0), focus: false, sel: false },
        { text: hdr("model", phase === 1), focus: false, sel: false },
        unsupported
          ? {
              text: hdr("effort (unsupported)", phase === 2),
              focus: false,
              sel: false,
            }
          : { text: hdr("effort", phase === 2), focus: false, sel: false },
      ];
    } else if (r === height - 1) {
      leaves.push(
        styled(
          [
            seg(
              truncateToWidth(
                "[space]select · [left/right]col · [tab]next col · [enter]commit · [esc]cancel",
                width,
              ).padEnd(width),
            ),
          ],
          { wrap: false },
        ),
      );
      continue;
    } else {
      const rowIdx = r - 1;
      cells[0] = renderColumnCell(
        { len: providers.length, at: (i) => providers[i]! },
        provStart,
        provRows,
        topO(provStart),
        bottomO(providers.length, provRows, provStart),
        rowIdx,
        listRows,
        phase,
        0,
        providerIndex,
        selectedProvider,
      );
      cells[1] = renderColumnCell(
        { len: models.length, at: (i) => models[i]! },
        modelStart,
        modelRows,
        topO(modelStart),
        bottomO(models.length, modelRows, modelStart),
        rowIdx,
        listRows,
        phase,
        1,
        modelIndex,
        selectedModel,
      );
      if (!unsupported) {
        cells[2] = renderColumnCell(
          {
            len: efforts.length,
            at: (i) => efforts[i]!.name,
            matchAt: (i) => efforts[i]!.id,
          },
          effStart,
          effRows,
          topO(effStart),
          bottomO(efforts.length, effRows, effStart),
          rowIdx,
          listRows,
          phase,
          2,
          effortIndex,
          selectedEffort,
        );
      }
    }

    const segs: import("../../renderer/screen.ts").FrameSegment[] = [];
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const t = truncateToWidth(c.text, widths[i]!).padEnd(widths[i]!);
      if (i > 0) segs.push({ text: " ".repeat(sep) });
      if (c.sel) segs.push({ text: t, style: { fg: "green" as const } });
      else if (c.focus)
        segs.push({ text: t, style: { fg: "yellow" as const } });
      else segs.push({ text: t });
    }
    leaves.push(styled(segs, { wrap: false }));
  }
  return v(leaves);
}

export function renderModelPicker(
  view: ModelPickerView,
  themeId: ThemeId,
): FrameRow[] {
  // 薄包装：单一数据源 buildModelPickerBox → fillBoxTree
  return fillBoxTree(
    buildModelPickerBox(view),
    view.height,
    view.width,
    themeId,
  );
}
