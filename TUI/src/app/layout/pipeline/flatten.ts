// src/app/layout/pipeline/flatten.ts — §6 摊平：已量好的 LayoutTree → Row[]
//
// 职责（追踪文档 T35-T38）：
//   - 逐 Leaf 取 wrapLeaf 行，按 prefix / suffix / indent / hanging / align 展开成 Row；
//   - 代码 / 表格 / 工具按各自网格 / 行模型铺行；
//   - 空 Leaf（Gap）→ 空行（**空行唯一来源**）；step / 回合头 tail 铺满；
//   - 不变式（测试）：摊平总行数 === Σ节点 height；空行只能来自显式 Gap。

import type { FrameSegment } from "../../../renderer/screen.ts";
import { seg, truncateToWidth } from "../primitives.ts";
import { displayWidth, expandCodeTabs } from "../markdown.ts";
import {
  TOOL_FAIL_GLYPH,
  TOOL_OK_GLYPH,
  TOOL_PENDING_GLYPH,
} from "../content-rules.ts";
import { wrapLeaf } from "./wrap.ts";
import type { Leaf, Node } from "./ir.ts";
import { isLeaf } from "./ir.ts";
import { prefixVisibleOf, suffixVisibleOf } from "./measure.ts";
import { fitCols, type TableAlign } from "../table.ts";
import { toolDiffSummary } from "../tool-line.ts";
import type { Paragraph, Row } from "./ir.ts";
import type { ToolUnit } from "./boxes.ts";

export interface FlattenOptions {
  /** 视口宽（prefix/suffix 的 minWidth 降级判定基准） */
  vw?: number;
}

type Seg = FrameSegment;

function rowW(segs: readonly Seg[]): number {
  return segs.reduce((s, x) => s + displayWidth(x.text), 0);
}

/** 单个文本叶 → Row[]（折行 + 前缀 / 后缀 / 悬挂 / 对齐 / tail） */
function flattenLeaf(node: Leaf, width: number, opts: FlattenOptions): Row[] {
  const prefixOn = prefixVisibleOf(node, opts.vw);
  const suffixOn = suffixVisibleOf(node, opts.vw);
  const prefixW = prefixOn ? displayWidth(node.prefix!.text) : 0;
  const suffixW = suffixOn ? displayWidth(node.suffix!.text) : 0;
  const bodyW = Math.max(1, width - prefixW - suffixW);
  const hanging = node.hanging ?? 0;
  // tail-only（空文本 + tail，如回合分隔线 / step 头空标签）
  if (node.text.length === 0 && node.tail) {
    return [
      {
        segments: [
          seg(node.tail.char.repeat(Math.max(1, width)), node.tail.style),
        ],
      },
    ];
  }
  const rows = wrapLeaf(node.text, bodyW, {
    prefixW,
    hanging,
    ...(node.balance === true ? { balance: true } : {}),
  });
  const maxBodyW = suffixOn ? Math.max(0, ...rows.map(rowW)) : 0;
  const indent = node.indent ?? 0;
  const prefixSegs: Seg[] = prefixOn
    ? [seg(node.prefix!.text, node.prefix!.style)]
    : [];
  const suffixSegs: Seg[] = suffixOn
    ? [seg(node.suffix!.text, node.suffix!.style)]
    : [];
  const out: Row[] = rows.map((line, ri) => {
    const padBody = suffixOn
      ? " ".repeat(Math.max(0, maxBodyW - rowW(line)))
      : "";
    const rowSegs: Seg[] = [
      ...prefixSegs,
      ...line,
      ...(padBody ? [seg(padBody)] : []),
      ...suffixSegs,
    ];
    const lead = ri === 0 ? indent : hanging;
    return {
      segments: lead > 0 ? [seg(" ".repeat(lead)), ...rowSegs] : rowSegs,
      indent: ri === 0 ? indent : hanging,
    };
  });
  if (node.tail) {
    for (const row of out) {
      const pad = Math.max(0, width - rowW(row.segments));
      if (pad > 0)
        row.segments.push(seg(node.tail.char.repeat(pad), node.tail.style));
    }
  }
  if (node.align && node.align !== "left") {
    for (const row of out) {
      const pad = width - rowW(row.segments);
      if (pad <= 0) continue;
      const leading = node.align === "right" ? pad : Math.floor(pad / 2);
      row.segments = [seg(" ".repeat(leading)), ...row.segments];
    }
  }
  return out;
}

/** 代码块 → Row[]（语言标记行 + 行号列 + 软折行，整行灰底补齐） */
function flattenCode(
  code: { lang: string; rows: readonly string[]; closed: boolean },
  width: number,
): Row[] {
  const numW = width >= 23 ? 3 : 0;
  const firstW = Math.max(4, width - numW);
  const contW = Math.max(2, firstW - 4);
  const bar: Seg = seg("┃", { fg: "brightBlue" });
  const out: Row[] = [];
  if (code.lang !== "") {
    out.push({
      segments: [bar, seg(" ".repeat(numW) + code.lang, { italic: true })],
    });
  }
  code.rows.forEach((row, i) => {
    const num =
      numW === 0 ? "" : (i + 1 > 99 ? "99+" : String(i + 1)).padStart(2) + " ";
    const src = expandCodeTabs(row);
    const chunks = codeChunks(src, firstW, contW);
    chunks.forEach(({ text, cont, lead }, k) => {
      const rowWk = k === 0 ? firstW : contW;
      const endMark = cont ? "↩" : "";
      const leadMark = lead ? "↪" : "";
      const pad = Math.max(
        0,
        rowWk -
          displayWidth(text) -
          displayWidth(leadMark) -
          displayWidth(endMark),
      );
      const indent = k === 0 ? num : " ".repeat(numW + 4);
      const padStr = k === 0 && !cont ? "" : " ".repeat(pad);
      out.push({
        segments: [
          bar,
          seg(indent + padStr + leadMark + text + endMark, { bg: "code" }),
        ],
      });
    });
  });
  return out;
}

/** 代码行软折行（与 measure 同口径行数；返回分段与行首 / 行尾标记） */
function codeChunks(
  src: string,
  firstW: number,
  contW: number,
): { text: string; cont: boolean; lead: boolean }[] {
  const out: { text: string; cont: boolean; lead: boolean }[] = [];
  let rest = src;
  let first = true;
  while (rest !== "") {
    const rowWk = Math.max(2, first ? firstW : contW);
    const leadW = first ? 0 : 1;
    if (displayWidth(rest) <= rowWk - leadW) {
      out.push({ text: rest, cont: false, lead: !first });
      break;
    }
    let cut = "";
    let cutW = 0;
    for (const ch of rest) {
      const w = displayWidth(ch);
      if (cut !== "" && cutW + w > Math.max(1, rowWk - leadW - 1)) break;
      cut += ch;
      cutW += w;
    }
    out.push({ text: cut, cont: true, lead: !first });
    rest = rest.slice(cut.length);
    first = false;
    if (cut === "") break;
  }
  if (out.length === 0) out.push({ text: "", cont: false, lead: false });
  return out;
}

function styledPlain(cell: Paragraph): string {
  return cell.text.map((s) => s.text).join("");
}

const CELL_PAD = 1;

/** 表格一行（每格按列宽折行；行高取最大） → Row[] */
function tableColSegs(
  cells: readonly Paragraph[],
  cols: number[],
  bar: Seg,
): Row[] {
  const cellRows = cells.map((c, j) =>
    wrapLeaf(c.text, Math.max(1, cols[j]!), { prefixW: 0, hanging: 0 }),
  );
  const h = Math.max(1, ...cellRows.map((r) => r.length));
  const out: Row[] = [];
  for (let ri = 0; ri < h; ri++) {
    const rowSegs: Seg[] = [bar, seg(" ")];
    for (let j = 0; j < cols.length; j++) {
      rowSegs.push(seg(" ".repeat(CELL_PAD)));
      const line = cellRows[j]![ri];
      if (line) rowSegs.push(...line);
      rowSegs.push(seg(" ".repeat(CELL_PAD)));
      if (j < cols.length - 1) rowSegs.push(seg("│"));
    }
    out.push({ segments: rowSegs });
  }
  return out;
}

/** 表格横线行（表头下 ═ / 数据行间 ─；交叉处交叉字） */
function tableRule(cols: number[], ch: string, cross: string, bar: Seg): Row {
  const segs: Seg[] = [bar, seg(" ")];
  cols.forEach((w, j) => {
    segs.push(seg(ch.repeat(Math.max(1, w + CELL_PAD * 2))));
    if (j < cols.length - 1) segs.push(seg(cross));
  });
  return { segments: segs };
}

/** 表格被宽度拒绝 → 退回普通文本行（内容完整、无表格线） */
function tableFallback(
  rows: readonly Paragraph[][],
  header: readonly Paragraph[],
): Row[] {
  const out: Row[] = [];
  for (const c of header) out.push({ segments: [{ text: styledPlain(c) }] });
  for (const row of rows)
    for (const c of row) out.push({ segments: [{ text: styledPlain(c) }] });
  return out;
}

/** 表格 → Row[] */
function flattenTable(
  table: {
    aligns: readonly TableAlign[];
    header: readonly Paragraph[];
    rows: readonly Paragraph[][];
  },
  width: number,
): Row[] {
  const ncols = table.header.length;
  if (ncols === 0) return [];
  const overhead = 1 + 1 + ncols + (ncols - 1);
  if (width < overhead + ncols) return tableFallback(table.rows, table.header);
  const natural = table.header.map((head, j) => {
    let w = displayWidth(styledPlain(head));
    for (const row of table.rows) {
      const cell = row[j];
      if (cell) w = Math.max(w, displayWidth(styledPlain(cell)));
    }
    return w;
  });
  const cols = fitCols(natural, width - overhead);
  if (cols === null) return tableFallback(table.rows, table.header);
  const bar: Seg = seg("┃", { fg: "brightBlue" });
  const out: Row[] = [];
  out.push(...tableColSegs(table.header, cols, bar));
  out.push(tableRule(cols, "═", "╪", bar));
  table.rows.forEach((row, i) => {
    if (i > 0) out.push(tableRule(cols, "─", "┼", bar));
    out.push(...tableColSegs(row, cols, bar));
  });
  return out;
}

/** 工具批 → Row[]（名字 / 参数 / 结果行；参数值悬挂缩进） */
function flattenTool(units: readonly ToolUnit[], width: number): Row[] {
  const out: Row[] = [];
  for (const unit of units) {
    if (unit.role === "name") {
      const glyph =
        unit.result === undefined
          ? TOOL_PENDING_GLYPH
          : unit.result.ok
            ? TOOL_OK_GLYPH
            : TOOL_FAIL_GLYPH;
      const fg = unit.result === undefined ? "yellow" : "green";
      const fitted = truncateToWidth(unit.call.name, Math.max(1, width - 3));
      const name = fitted === unit.call.name ? unit.call.name : fitted + "…";
      out.push({
        rowKind: "tool-name",
        segments: [seg(glyph, { fg }), seg(" "), seg(name, { fg: "yellow" })],
      });
    } else if (unit.role === "param") {
      const value = unit.param.value;
      const name = unit.param.name;
      const rows = wrapLeaf([{ text: value }], Math.max(1, width - 6), {
        prefixW: 0,
        hanging: 6,
      });
      rows.forEach((r, i) => {
        // 首行：缩进 4（具名附 `name ` 前缀）；续行悬挂 6 列
        const lead =
          i === 0 ? " ".repeat(4) + (name ? name + " " : "") : " ".repeat(6);
        out.push({
          rowKind: "tool-param",
          segments: [seg(lead + plain(r))],
        });
      });
    } else {
      // 结果行：详情 + `(+N/-M)` 摘要（挂首行末尾）；静默（空详情且无摘要）整条省略
      const text = toolResultText(unit.result);
      if (text === "") continue;
      const rows = wrapLeaf([{ text }], Math.max(1, width - 2), {
        prefixW: 0,
        hanging: 2,
      });
      rows.forEach((r) => {
        out.push({ rowKind: "tool-result", segments: [seg("  " + plain(r))] });
      });
    }
  }
  return out;
}

/** 工具结果行文本：详情（去尾空白）+ `(+N/-M)` 摘要（挂**首行**末尾；详情为空时只出摘要） */
function toolResultText(result: { detail: string; meta?: unknown }): string {
  const detail = result.detail.replace(/\s+$/, "");
  const diff = toolDiffSummary(result.meta);
  if (diff === undefined) return detail;
  const at = detail.indexOf("\n");
  if (at < 0) return detail === "" ? diff : detail + " " + diff;
  return detail.slice(0, at) + " " + diff + detail.slice(at);
}

function plain(row: readonly { text: string }[]): string {
  return row.map((s) => s.text).join("");
}

/** 递归摊平已量好的树 */
export function flatten(
  tree: Node | Leaf,
  width: number,
  opts: FlattenOptions = {},
): Row[] {
  if (isLeaf(tree)) return flattenLeaf(tree, width, opts);
  if (tree.code !== undefined)
    return flattenCode(tree.code, Math.max(1, width - 1));
  if (tree.table !== undefined)
    return flattenTable(tree.table, Math.max(1, width - 1));
  if (tree.tool !== undefined) return flattenTool(tree.tool, width);
  if (tree.direction === "v") {
    const out: Row[] = [];
    for (const child of tree.children) out.push(...flatten(child, width, opts));
    return out;
  }
  // h：子项行按行号拼接（各子项已量好自身宽）
  const subs: Row[][] = tree.children.map((c) => {
    const cw = Math.max(1, c.width ?? width);
    return flatten(c, cw, opts);
  });
  const h = Math.max(1, ...subs.map((r) => r.length));
  const out: Row[] = [];
  for (let ri = 0; ri < h; ri++) {
    const rowSegs: Seg[] = [];
    for (const s of subs) {
      const line = s[ri];
      if (line) rowSegs.push(...line.segments);
    }
    out.push({ segments: rowSegs });
  }
  return out;
}

/**
 * 逐项摊平：对面板根（v 容器，每个顶层 child 恰对应一个 PaneItem）返回**按 child
 * 归属**的行数组——`result[i]` = 第 i 个 PaneItem 摊出的 Row[]（可为空）。
 *
 * 用途（§3 接线桥）：老渲染层按「段键 + 段内行」定位滚动 / 收集用户块首行号，新链路
 * 的 `Row[]` 只有扁平段落。由于面板根 v 容器的每个顶层 child 与 `PaneItem` 一一对应
 * （structure.toPaneTree 的构建方式），本函数把一次 `flatten` 拆成逐 child 的一次，
 * 使**每个 item 的段落边界精确可读**，且总行数与整树 `flatten` 逐字节一致（不变量：
 * Σ result[i].length === flatten(root).length）。
 *
 * - 对非 v 根（单 item 面板，或根即 item 子树）：返回 `[flatten(root)]` 单段；
 * - 对 v 根：逐 child 在 `width` 下摊平（顶层 child 占满面板宽，tail 铺满 / 前缀一致）。
 */
export function flattenAttributed(
  root: Node | Leaf,
  width: number,
  opts: FlattenOptions = {},
): Row[][] {
  if (isLeaf(root)) return [flatten(root, width, opts)];
  if (root.direction === "v") {
    return root.children.map((c) => flatten(c, width, opts));
  }
  // 根为 h 容器：整体作为一段（子项按各自宽水平并置，不可再按 child 归属）
  return [flatten(root, width, opts)];
}
