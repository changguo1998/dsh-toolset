// src/app/components/ModelPicker.ts — /model 交互选择面板渲染（纯函数）
//
// 输出恰 height 行，**三列独立列表同屏**：provider / model / effort 三列独立
// 滚动，头部全小写。Tab 循环切换焦点分区（phase 0=provider，1=model，
// 2=effort）。当前生效的 provider/model/effort 在各列标 `*`（无 [current]
// 后缀）；焦点行标 `>`。焦点列标题用 `[ ]` 方括号包裹（如 `[ provider ]`），
// 列表行不加边框。某列上方/下方有未显示项时，可视区顶部/底部对应行显示
// `...` 省略号（焦点所在行不显示省略号，保证焦点恒可见）。

import type { RenderLine } from "../../renderer/index.ts";
import type { PickerState } from "../state.ts";
import { truncateToWidth } from "../layout.ts";

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
 * 单元格行内标记：当前生效值标 `*`，焦点行标 `>`，其余留空。
 * @param currentOf 该列当前生效值（无则空，如 effort 列当前无等级）
 */
function markCell(
  value: string,
  currentOf: string | undefined,
  isFocusRow: boolean,
): string {
  if (value === currentOf) return "* ";
  if (isFocusRow) return "> ";
  return "  ";
}

/** 单个列表列：省略号（顶/底）+ 内容区渲染 */
function renderColumnCell(
  items: { len: number; at: (i: number) => string },
  start: number,
  contentRows: number,
  topO: boolean,
  bottomO: boolean,
  rowIdx: number,
  listRows: number,
  phase: number,
  thisPhase: number,
  focus: number,
  currentOf: string | undefined,
): string {
  if (rowIdx === 0 && topO) return " ..."; // 顶部省略号占首数据行
  if (rowIdx === listRows - 1 && bottomO) return " ..."; // 底部省略号占末数据行
  const contentRow = rowIdx - (topO ? 1 : 0); // 顶部省略号后内容区起点
  if (contentRow < 0 || contentRow >= contentRows) return "";
  const idx = start + contentRow;
  if (idx < 0 || idx >= items.len) return "";
  const v = items.at(idx);
  const f = phase === thisPhase && idx === focus;
  return markCell(v, currentOf, f) + v;
}

export function renderModelPicker(view: ModelPickerView): RenderLine[] {
  const {
    providers,
    providerIndex,
    models,
    modelIndex,
    efforts,
    effortIndex,
    phase,
    current,
  } = view.picker;
  const height = Math.max(1, view.height);
  const width = Math.max(1, view.width);
  // 三列宽分配（列间各 1 空格分隔）
  const sep = width >= 32 ? 2 : 1; // 宽屏用双空格分隔，窄屏单空格
  const provW = Math.min(16, Math.max(6, Math.floor(width * 0.22)));
  const remain = Math.max(1, width - provW - sep * 2);
  const thinkW = Math.max(10, Math.floor(remain * 0.4));
  const modelW = Math.max(1, remain - thinkW);
  const widths = [provW, modelW, thinkW];

  const listRows = Math.max(1, height - 1); // 首行为三列头部
  const contentRows = Math.max(1, listRows - 2); // 预留给顶/底省略号各 1 行
  const unsupported = efforts.length === 0;
  // 三列各自滚动：焦点恒落在内容区（不含省略号占位行）
  const colStart = (len: number, focus: number) =>
    scrollStart(len, focus, contentRows);
  const provStart = colStart(providers.length, providerIndex);
  const modelStart = colStart(models.length, modelIndex);
  const effStart = colStart(efforts.length, effortIndex);
  const topO = (len: number, start: number) => start > 0;
  const bottomO = (len: number, start: number) => start + contentRows < len;
  const rows: RenderLine[] = [];
  for (let r = 0; r < height; r++) {
    let cells: string[] = ["", "", ""];
    if (r === 0) {
      // 焦点列标题用 [ ] 包裹；effort 无等级时标注 unsupported
      const hdr = (t: string, isF: boolean) => (isF ? `[ ${t} ]` : ` ${t}`);
      cells = [
        hdr("provider", phase === 0),
        hdr("model", phase === 1),
        unsupported
          ? hdr("effort (unsupported)", phase === 2)
          : hdr("effort", phase === 2),
      ];
    } else {
      const rowIdx = r - 1;
      cells[0] = renderColumnCell(
        { len: providers.length, at: (i) => providers[i]! },
        provStart,
        contentRows,
        topO(providers.length, provStart),
        bottomO(providers.length, provStart),
        rowIdx,
        listRows,
        phase,
        0,
        providerIndex,
        current?.provider,
      );
      cells[1] = renderColumnCell(
        { len: models.length, at: (i) => models[i]! },
        modelStart,
        contentRows,
        topO(models.length, modelStart),
        bottomO(models.length, modelStart),
        rowIdx,
        listRows,
        phase,
        1,
        modelIndex,
        current?.model,
      );
      if (!unsupported) {
        cells[2] = renderColumnCell(
          { len: efforts.length, at: (i) => efforts[i]!.name },
          effStart,
          contentRows,
          topO(efforts.length, effStart),
          bottomO(efforts.length, effStart),
          rowIdx,
          listRows,
          phase,
          2,
          effortIndex,
          current?.reasoningEffort,
        );
      }
    }

    // 先按列宽截断、补空格对齐到列宽（ANSI 不进入宽度计算）
    const cols = cells.map((c, i) => {
      const fitted = truncateToWidth(c, widths[i]!).padEnd(widths[i]!);
      return fitted;
    });
    rows.push({ text: cols.join(" ".repeat(sep)) });
  }
  return rows;
}
