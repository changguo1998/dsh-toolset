// src/app/layout/pipeline/measure.ts — §5 测量：LayoutTree + 宽 → 各节点宽高
//
// 职责（追踪文档 T30-T34）：根拿屏幕宽（每个 pane 各自量），后序填各节点 width/height。
//   - 文本叶：height = wrapLeaf(leaf.text, bodyW, …).length（**唯一折行**，禁止估算）；
//   - 代码 / 表格 / 工具载荷：按各自行数模型量高（折行也走 wrapLeaf）；
//   - v 容器高 = 子高之和；h 容器高 = 子高之最（宽度按声明分配）。
//   - 不变式（测试）：叶子 height === wrapLeaf(…).length；摊平总行数 === Σ节点 height。

import type { TableAlign } from "../table.ts";
import { fitCols } from "../table.ts";
import { expandCodeTabs, displayWidth, charWidth } from "../markdown.ts";
import { wrapLeaf } from "./wrap.ts";
import type { Leaf, Node, Paragraph } from "./ir.ts";
import { isLeaf } from "./ir.ts";
import type { ToolUnit } from "./boxes.ts";

export interface MeasureOptions {
  /** 视口宽（prefix/suffix 的 minWidth 降级判定基准） */
  vw?: number;
}

export function prefixVisibleOf(
  p: { prefix?: { minWidth?: number } } | undefined,
  vw: number | undefined,
): boolean {
  if (!p?.prefix) return false;
  if (p.prefix.minWidth !== undefined && (vw ?? 0) < p.prefix.minWidth)
    return false;
  return true;
}

export function suffixVisibleOf(
  p: { suffix?: { minWidth?: number } } | undefined,
  vw: number | undefined,
): boolean {
  if (!p?.suffix) return false;
  if (p.suffix.minWidth !== undefined && (vw ?? 0) < p.suffix.minWidth)
    return false;
  return true;
}

export function prefixWidthOf(
  node: Node | Leaf,
  vw: number | undefined,
): number {
  return prefixVisibleOf(node, vw) ? displayWidth(node.prefix!.text) : 0;
}

export function suffixWidthOf(
  node: Node | Leaf,
  vw: number | undefined,
): number {
  return suffixVisibleOf(node, vw) ? displayWidth(node.suffix!.text) : 0;
}

/** 文本叶在给定（已扣前缀 / 后缀的）正文宽下的折行行数 == 高度 */
export function leafRows(
  node: Leaf,
  width: number,
  opts: MeasureOptions,
): number {
  const prefixW = prefixWidthOf(node, opts.vw);
  const suffixW = suffixWidthOf(node, opts.vw);
  const bodyW = Math.max(1, width - prefixW - suffixW);
  const hanging = node.hanging ?? 0;
  return wrapLeaf(node.text, bodyW, {
    prefixW,
    hanging,
    ...(node.balance === true ? { balance: true } : {}),
  }).length;
}

/** 代码块行数模型：行号列 + 每物理行软折行（与 flatten 同源） */
export function codeHeight(
  code: { lang: string; rows: readonly string[]; closed: boolean },
  avail: number,
): number {
  const numW = avail >= 23 ? 3 : 0;
  const firstW = Math.max(4, avail - numW);
  const contW = Math.max(2, firstW - 4);
  let h = 0;
  if (code.lang !== "") h += 1;
  for (const row of code.rows) {
    const src = expandCodeTabs(row);
    h += codeScreenRows(src, firstW, contW);
  }
  return h;
}

/** 代码行软折行行数（步进式切段；与 flatten 共用同一折行口径） */
function codeScreenRows(src: string, firstW: number, contW: number): number {
  if (src === "") return 1;
  let n = 0;
  let rest = src;
  let first = true;
  while (rest !== "") {
    const rowW = first ? firstW : contW;
    const leadW = first ? 0 : 1;
    if (displayWidth(rest) <= rowW - leadW) {
      n += 1;
      break;
    }
    let cut = "";
    let cutW = 0;
    for (const ch of rest) {
      const w = charWidth(ch);
      if (cut !== "" && cutW + w > Math.max(1, rowW - leadW - 1)) break;
      cut += ch;
      cutW += w;
    }
    rest = rest.slice(cut.length);
    n += 1;
    first = false;
    if (cut === "") break; // 防死循环（首字符超宽）
  }
  return n;
}

/** 单元格高度（行内折行行数；格无 prefix） */
function cellRows(cell: Paragraph, colW: number): number {
  return wrapLeaf(cell.text, Math.max(1, colW), { prefixW: 0, hanging: 0 })
    .length;
}

function styledPlain(cell: Paragraph): string {
  return cell.text.map((s) => s.text).join("");
}

/** 表格高度：fitCols 定列宽 → 各行高 = 格 wrapLeaf 行数最大 → 求和（含横线行） */
export function tableHeight(
  table: {
    aligns: readonly TableAlign[];
    header: readonly Paragraph[];
    rows: readonly Paragraph[][];
  },
  width: number,
): number {
  const ncols = table.header.length;
  if (ncols === 0) return 1;
  const overhead = 1 + 1 + ncols + (ncols - 1);
  if (width < overhead + ncols) return 1;
  const natural = table.header.map((head, j) => {
    let w = displayWidth(styledPlain(head));
    for (const row of table.rows) {
      const cell = row[j];
      if (cell) w = Math.max(w, displayWidth(styledPlain(cell)));
    }
    return w;
  });
  const cols = fitCols(natural, width - overhead);
  if (cols === null) return 1;
  const rows: Paragraph[][] = [table.header as Paragraph[], ...table.rows];
  let h = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let rh = 1;
    for (let j = 0; j < row.length; j++)
      rh = Math.max(rh, cellRows(row[j]!, cols[j]!));
    h += rh;
    if (i < rows.length - 1) h += 1; // 表头下 / 数据行间横线
  }
  return h;
}

/** 工具批高度：每逻辑行单元按宽折行行数之和 */
export function toolHeight(units: readonly ToolUnit[], width: number): number {
  let h = 0;
  for (const unit of units) {
    const indent = unit.role === "param" ? 6 : unit.role === "result" ? 2 : 0;
    const hang = unit.role === "param" ? 6 : 2;
    const rows = wrapLeaf(
      [{ text: unitText(unit) }],
      Math.max(1, width - indent),
      {
        prefixW: 0,
        hanging: hang,
      },
    );
    h += rows.length;
  }
  return Math.max(1, h);
}

function unitText(unit: ToolUnit): string {
  if (unit.role === "name") return unit.call.name;
  if (unit.role === "param")
    return (unit.param.name ? unit.param.name + ": " : "") + unit.param.value;
  return unit.result.detail;
}

/** 测量主入口：写各节点 width / height，返回树高 */
export function measure(
  tree: Node | Leaf,
  width: number,
  opts: MeasureOptions = {},
): number {
  const w = Math.max(1, Math.floor(width));
  if (isLeaf(tree)) {
    tree.width = w;
    tree.height = leafRows(tree, w, opts);
    return tree.height;
  }
  tree.width = w;
  if (tree.code !== undefined) {
    tree.height = codeHeight(tree.code, Math.max(1, w - 1));
    return tree.height;
  }
  if (tree.table !== undefined) {
    tree.height = tableHeight(tree.table, Math.max(1, w - 1));
    return tree.height;
  }
  if (tree.tool !== undefined) {
    tree.height = toolHeight(tree.tool, w);
    return tree.height;
  }
  if (tree.direction === "h") {
    // h：固定宽子项（符号格）先定值，其余分剩余；高 = max 子高
    let remaining = w;
    const fixed = new Map<Node | Leaf, number>();
    for (const child of tree.children) {
      const fixedW = child.widthFixed;
      if (child.widthStyle === "fixed" || (fixedW ?? 0) > 0) {
        const cw = Math.max(1, fixedW ?? 1);
        fixed.set(child, cw);
        remaining -= cw;
      }
    }
    const autos = tree.children.filter((c) => !fixed.has(c));
    let h = 0;
    for (const [child, cw] of fixed) h = Math.max(h, measure(child, cw, opts));
    for (const child of autos) {
      const cw =
        autos.length > 0
          ? Math.max(1, Math.floor(remaining / autos.length))
          : 1;
      h = Math.max(h, measure(child, cw, opts));
    }
    tree.height = h;
    return h;
  }
  // v：子项同宽，高求和
  let h = 0;
  for (const child of tree.children) h += measure(child, w, opts);
  tree.height = h;
  return h;
}
