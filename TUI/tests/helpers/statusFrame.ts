// tests/helpers/statusFrame.ts — 状态列「帧内可见行」还原（内容层产出 → 屏幕所见）
//
// 2026-10-12 改造后：`renderStatusColumn` 只产**正文行**（`ContentRow[]`，不含右缘竖线、
// 不补白）——截断 / 补白 / 分隔竖线由拼帧层（`buildTopRegion` 的 statusBody +
// `divFor` 的 `│`）构图。测试要按屏幕所见断言，故此处按同一口径还原：
// 截断到正文宽 → 右补空格 → 追加分隔竖线；内容不足 height 时补空白行（帧内状态列恒占满
// 内容行数——拼帧层对缺行补白）。
//
// 供 `status-column.test.ts` / `status-column-agents.test.ts` / `status-column-equivalence.test.ts`
// 共用（单一实现，避免三处口径漂移）。

import type { FrameRow } from "../../src/renderer/screen.ts";
import {
  rowWidth2,
  seg,
  truncateSegs,
} from "../../src/app/layout/primitives.ts";

/** 状态列正文行 → 帧内可见行：恰 `height` 行，每行 `bodyW` + 1 列（分隔竖线） */
export function statusFrameRows(
  rows: readonly FrameRow[],
  bodyW: number,
  height: number,
): FrameRow[] {
  const w = Math.max(1, bodyW);
  const h = Math.max(1, height);
  const out: FrameRow[] = rows.map((l) => {
    const inner = truncateSegs([...l.segments], w);
    const used = rowWidth2(inner);
    return {
      segments: [...inner, seg(" ".repeat(Math.max(0, w - used))), seg("│")],
    };
  });
  while (out.length < h) out.push({ segments: [seg(" ".repeat(w)), seg("│")] });
  return out.slice(0, h);
}
