// src/app/layout/pipeline/compose.ts — §7 组装：各 pane Row[] → FrameRow[]
//
// 职责（追踪文档 T39-T42）：把摊平的各 pane Row[] 按屏上布局排布并合成 FrameRow[]。
// 本项目约束（追踪文档「偏差 ③」）：chrome 五 pane 与视口 / 状态栏 / 输入行的拼装
// 由 `layout.ts` 现状（`buildTopRegion` / `buildFrame`）承担，本层只提供
// `renderPane` 便捷入口（新链路 §1→§7 的一条龙窄接口）与 `rowsToFrame`（Row → FrameRow）。

import type { FrameRow } from "../../../renderer/screen.ts";
import type { Row } from "./ir.ts";
import { parse } from "./parse.ts";
import { route } from "./route.ts";
import { buildTrees } from "./structure.ts";
import { measure } from "./measure.ts";
import { flatten } from "./flatten.ts";
import type { EventGroup } from "./ir.ts";

/** Row[] → FrameRow[]（Row.segments 已是屏上段；kind 等语义由上层另存） */
export function rowsToFrame(rows: readonly Row[]): FrameRow[] {
  return rows.map((row) => ({
    segments: row.segments as FrameRow["segments"],
  }));
}

export interface RenderPaneResult {
  /** 每 pane 的摊平行 */
  rows: { session?: Row[]; turn?: Row[] };
  /** 每条 frame 行（session + turn 按序并置的展示视图；两 pane 同宽时用） */
  frame: FrameRow[];
}

/**
 * 新链路一条龙（阶段 3 接线用）：EventGroup[] → 两 pane 的 Row[] 与 FrameRow[]。
 * 各 pane 分别以给定宽度测量 / 摊平（session / turn 宽度可不同）。
 */
export function renderPane(
  groups: readonly EventGroup[],
  opts: {
    sessionWidth: number;
    turnWidth?: number;
    view?: Parameters<typeof route>[1];
    vw?: number;
  } = { sessionWidth: 80 },
): RenderPaneResult {
  const { session, turn } = route(groups, opts.view);
  const trees = buildTrees(session, turn);
  const rows: RenderPaneResult["rows"] = {};
  // session
  measure(trees.session, opts.sessionWidth, {
    vw: opts.vw ?? opts.sessionWidth,
  });
  rows.session = flattenRows(trees.session, opts.vw ?? opts.sessionWidth);
  // turn
  const turnW = Math.max(1, opts.turnWidth ?? opts.sessionWidth);
  measure(trees.turn, turnW, { vw: opts.vw ?? turnW });
  rows.turn = flattenRows(trees.turn, opts.vw ?? turnW);
  return {
    rows,
    frame: [
      ...rowsToFrame(rows.session ?? []),
      ...rowsToFrame(rows.turn ?? []),
    ],
  };
}

function flattenRows(tree: Parameters<typeof flatten>[0], vw: number): Row[] {
  const width = Math.max(1, tree.width ?? vw);
  return flatten(tree, width, { vw });
}
