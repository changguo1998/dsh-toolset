// src/app/layout/pipeline/measure.ts — §5 测量：LayoutTree + 宽 → 各节点宽高
//
// 职责（追踪文档 T30-T34）：根拿屏幕宽（每个 pane 各自量），后序填各节点 width/height。
//   - 文本叶：height = wrapLeaf(leaf.text, bodyW, …).length（**唯一折行**，禁止估算）；
//   - 代码 / 表格 / 工具载荷：按各自行数模型量高（折行也走 wrapLeaf）；
//   - v 容器高 = 子高之和；h 容器高 = 子高之最（宽度按声明分配）。
//   - 不变式（测试）：叶子 height === wrapLeaf(…).length；摊平总行数 === Σ节点 height。

import { fitCols, type TableAlign } from "../table.ts";
import { expandCodeTabs, displayWidth, charWidth } from "../markdown.ts";
import type { ColorName } from "../../../renderer/theme.ts";
import type { FrameStyle } from "../../../renderer/screen.ts";
import { balancedWidth } from "../fill.ts";
import { wrapLeaf, styledToSegments } from "./wrap.ts";
import type { Leaf, Node, Paragraph, StyledText } from "./ir.ts";
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
  if (node.heightStyle === "fixed" && node.heightFixed !== undefined)
    return Math.max(1, node.heightFixed);
  const bodyW = Math.max(1, width - prefixW - suffixW);
  return wrapLeaf(node.text, bodyW, {
    prefixW: 0,
    hanging: 0,
    ...(node.balance === true ? { balance: true } : {}),
  }).length;
}

/**
 * h 容器 auto 子项的自然宽：
 *  - 带 balance 的文本叶：平衡折行宽（`balancedWidth`），让各行尽量等宽；
 *  - 其余文本叶：首行不折行所需宽（≤ 预算）；
 *  - h 容器：递归取「固定宽之和 + auto/fill 子项自然宽」，代表整块首选宽；
 *  - 其它容器（v 等）：无先验自然宽，返回预算。
 */
function naturalHWidth(
  child: Node | Leaf,
  budget: number,
  opts: MeasureOptions,
): number {
  if (isLeaf(child)) {
    const prefixW = prefixVisibleOf(child, opts.vw)
      ? displayWidth(child.prefix?.text ?? "")
      : 0;
    const suffixW = suffixVisibleOf(child, opts.vw)
      ? displayWidth(child.suffix?.text ?? "")
      : 0;
    const avail = Math.max(1, budget - prefixW - suffixW);
    if (child.balance === true) {
      // 自然宽优先取「内容自身宽」：短文本单行 → 其内容宽（fill spacer 吃剩余，
      // 不会因 balancedWidth 对单行返回 maxWidth 而把整宽占掉）；需折行才用平衡宽。
      const unwrapped = wrapLeaf(child.text, avail, {
        prefixW: 0,
        hanging: 0,
      });
      const contentW = unwrapped.reduce(
        (m, r) => Math.max(m, displayWidth(r.map((s) => s.text).join(""))),
        0,
      );
      if (contentW <= avail) return contentW + prefixW + suffixW;
      return (
        balancedWidth(styledToSegments(child.text), avail, 0) +
        prefixW +
        suffixW
      );
    }
    const rows = wrapLeaf(child.text, avail, {
      prefixW: 0,
      hanging: 0,
    });
    const used = rows.reduce(
      (m, r) => Math.max(m, displayWidth(r.map((s) => s.text).join(""))),
      0,
    );
    return Math.min(avail, used) + prefixW + suffixW;
  }
  // 容器：自身装饰列（prefix / suffix / 右缘留白）同样占宽——与叶子同口径，
  // 否则 auto 分配会少给装饰列，子内容在真实宽下提前折行
  const prefixW = prefixVisibleOf(child, opts.vw)
    ? displayWidth(child.prefix?.text ?? "")
    : 0;
  const suffixW = suffixVisibleOf(child, opts.vw)
    ? displayWidth(child.suffix?.text ?? "")
    : 0;
  const decor = prefixW + suffixW;
  const inner = Math.max(1, budget - decor);
  if (child.direction === "h") {
    let fixedSum = 0;
    let autoMax = 0;
    for (const sub of child.children) {
      const style = sub.widthStyle ?? "auto";
      if (style === "fixed" || (sub.widthFixed ?? 0) > 0) {
        fixedSum += Math.max(1, sub.widthFixed ?? 1);
      } else if (style === "fill") {
        autoMax = Math.max(autoMax, sub.widthMin ?? 0);
      } else {
        autoMax = Math.max(autoMax, naturalHWidth(sub, inner, opts));
      }
    }
    return Math.min(budget, decor + fixedSum + autoMax);
  }
  // v 容器自然宽 = 子项自然宽的最大值（子项同宽，取最宽者）
  let widest = 0;
  for (const sub of child.children) {
    widest = Math.max(widest, naturalHWidth(sub, inner, opts));
  }
  return Math.min(budget, decor + Math.max(1, widest));
}

/**
 * 代码列：**先拆行、再分列** —— 每个物理行一个 `Box(h, separator ┃)`，
 * 行内左列是行号格、右列是代码填充盒。
 * 折行续行由代码填充盒自己做，行号列在续行上自动留空、分隔竖线照画。
 * 不做窄宽特判：行号列恒在（2 列，≥ 100 行时 3 列）。
 */
function codeLines(code: {
  lang: string;
  rows: readonly string[];
  closed: boolean;
}): Node[] {
  const numW = code.rows.length >= 100 ? 3 : 2;
  const line = (
    num: string,
    text: string,
    style: { code?: boolean; italic?: boolean },
  ): Node => ({
    direction: "h",
    separator: { char: "┃", color: "brightBlue" },
    children: [
      {
        direction: "v",
        widthStyle: "fixed",
        widthFixed: numW,
        children: [{ text: num === "" ? [] : [{ text: num }] }],
      },
      {
        direction: "v",
        widthStyle: "fill",
        children: [{ text: text === "" ? [] : [{ text, ...style }] }],
      },
    ],
  });
  const out: Node[] = [];
  if (code.lang !== "") out.push(line("", code.lang, { italic: true }));
  code.rows.forEach((row, i) => {
    const num = i + 1 > 999 ? "999" : String(i + 1).padStart(numW);
    out.push(line(num, expandCodeTabs(row), { code: true }));
  });
  return out;
}

/** §5 展开代码块：`Box(v)[ 每个物理行一个行盒 ]`（行盒内再用 separator 分行号列 / 代码列） */
function expandCode(tree: Node, width: number): void {
  const code = tree.code!;
  tree.code = undefined;
  tree.direction = "v";
  tree.separator = undefined;
  tree.children = codeLines(code);
}

/** 表格格距 / 左缘竖线与表格内容之间的间隔（与旧渲染同口径） */
/** 单元格纯文本（自然宽口径） */
function plainOf(cell: Paragraph): string {
  return cell.text.map((s) => s.text).join("");
}

/** 表格数据行：行盒只带 `separator`（列竖线），格本身不带留白与宽度 */
function tableRow(
  cells: readonly Paragraph[],
  aligns: readonly TableAlign[],
  header: boolean,
  sep: string,
): Node {
  return {
    direction: "h",
    separator: { char: sep },
    children: cells.map((cell, j) => {
      const text = header
        ? cell.text.map((s) => ({ ...s, bold: true }))
        : cell.text;
      return { text, align: aligns[j] ?? "left" } as Leaf;
    }),
  };
}

/** 表格横线行：每列一个 `fill` 盒，靠 `fillWith` 铺满该列分配宽；交叉字由 separator 给 */
function tableRuleRow(ncols: number, ch: string, cross: string): Node {
  return {
    direction: "h",
    separator: { char: cross },
    children: Array.from({ length: Math.max(1, ncols) }, (): Node => ({
      direction: "v",
      widthStyle: "fill",
      fillWith: { text: ch },
      children: [],
    })),
  };
}

/** §5 展开表格：`Box(v, grid)[表头行, ═ 横线, 数据行…]`；过窄退回逐格文本行 */
function expandTable(tree: Node, width: number): void {
  const table = tree.table!;
  tree.table = undefined;
  tree.direction = "v";
  tree.grid = true;
  const ncols = table.header.length;
  const natural = table.header.map((head, j) => {
    let w = displayWidth(plainOf(head));
    for (const row of table.rows) {
      const cell = row[j];
      if (cell) w = Math.max(w, displayWidth(plainOf(cell)));
    }
    return w;
  });
  // 不做窄宽退化：列宽压不下时每列兜底 1 列，结构始终是 grid（列宽算法下一步挪进 grid pass）
  const cols =
    ncols === 0
      ? []
      : (fitCols(natural, Math.max(1, width - ncols)) ?? natural.map(() => 1));
  const body: (Node | Leaf)[] = [
    tableRow(table.header, table.aligns, true, "│"),
    tableRuleRow(ncols, "═", "╪"),
  ];
  table.rows.forEach((row, i) => {
    if (i > 0) body.push(tableRuleRow(ncols, "─", "┼"));
    body.push(tableRow(row, table.aligns, false, "│"));
  });
  tree.children = body;
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
  if (tree.code !== undefined) expandCode(tree, w); // §5 展开：载荷 → 结构
  if (tree.table !== undefined) expandTable(tree, w);
  // 带 prefix / suffix 的 Node：符号占列，子项按缩窄后的宽测量（与 flatten 同口径）。
  // 左缘 chrome 列（对话/session 面板竖线）不吃正文宽。
  if (tree.prefix !== undefined || tree.suffix !== undefined) {
    const boxW = Math.max(
      1,
      w - prefixWidthOf(tree, opts.vw) - suffixWidthOf(tree, opts.vw),
    );
    if (tree.direction === "h") {
      // h：按 h 的 fixed/auto/fill 规则在缩窄后的 boxW 内分配（不能把 boxW 平铺给每个子项）
      tree.height = measureH(tree, boxW, opts);
    } else {
      let h = 0;
      for (const child of tree.children) h += measure(child, boxW, opts);
      tree.height = h;
    }
    return tree.height;
  }
  if (tree.direction === "h") return measureH(tree, w, opts);
  // v：子项同宽，高求和；空容器也占一行（与 flatten 的「空容器产一行」同口径）
  let h = 0;
  for (const child of tree.children) h += measure(child, w, opts);
  tree.height = Math.max(1, h);
  return tree.height;
}

/** h 容器的分隔竖线总宽（相邻子项之间各一条；< 2 个子项不插） */
function separatorWidth(node: Node): number {
  const sep = node.separator;
  if (sep === undefined || node.children.length < 2) return 0;
  return displayWidth(sepChar(sep)) * (node.children.length - 1);
}

/** 分隔符字符（缺省横向用 `│`，与 Separator 注释同口径） */
export function sepChar(sep: { char?: string }): string {
  return sep.char ?? "│";
}

/** 分隔符样式：`plain` = 不染色，缺省 border 灰 */
export function sepStyle(sep: {
  color?: ColorName | "plain";
}): FrameStyle | undefined {
  const color = sep.color;
  if (color === "plain") return undefined;
  return { fg: color ?? "border" };
}

/** h 容器测量：fixed 先定值 → auto 取自然宽 → fill 均分剩余；返回最大子高 */
function measureH(tree: Node, w: number, opts: MeasureOptions): number {
  // 分隔竖线占列：先从可用宽扣掉，剩余再按 fixed / auto / fill 分配
  const avail = Math.max(1, w - separatorWidth(tree));
  const fixed = new Map<Node | Leaf, number>();
  const autos: (Node | Leaf)[] = [];
  const fills: (Node | Leaf)[] = [];
  for (const child of tree.children) {
    const style = child.widthStyle ?? "auto";
    if (style === "fixed" || (child.widthFixed ?? 0) > 0) {
      fixed.set(child, Math.max(1, child.widthFixed ?? 1));
    } else if (style === "fill") {
      fills.push(child);
    } else {
      autos.push(child);
    }
  }
  let fixedSum = 0;
  for (const cw of fixed.values()) fixedSum += cw;
  // fill 的 widthMin 是先占位的保底：auto 只能分配 fixed 与 fill 保底之外的剩余列，
  // 否则 auto 的自然宽会连同保底一起吃掉，合计超过容器宽（用户块正文曾因此超 2 列）
  const fillMin = fills.reduce((a, c) => a + Math.max(0, c.widthMin ?? 0), 0);
  // auto 自然宽：文本叶 = min(展示宽 + 前缀/后缀, 剩余)；带 balance 的叶取剩余（尽力均摊）
  let remaining = Math.max(0, avail - fixedSum - fillMin);
  const autoW = new Map<Node | Leaf, number>();
  for (const child of autos) {
    const natural = naturalHWidth(child, remaining, opts);
    autoW.set(child, Math.max(1, Math.min(natural, Math.max(1, remaining))));
    remaining = Math.max(0, remaining - autoW.get(child)!);
  }
  // 有 fill 保底时，auto 分完后把保底列加回到可分配空间（fill 要吃「剩余 + 保底」）
  const fillSpace = Math.max(0, remaining);
  // fill：各给 widthMin 保底；剩余列给**第一个** fill（左侧 spacer 吃剩余 → 内容贴右）。
  const fillW = new Map<Node | Leaf, number>();
  if (fills.length > 0) {
    const mins = fills.map((c) => Math.max(0, c.widthMin ?? 0));
    const minSum = mins.reduce((a, b) => a + b, 0);
    const rest = Math.max(0, fillSpace);
    // 剩余列在多个 fill 之间均分（余数给靠前的）；只有一个 fill 时即「吃下全部剩余」
    const share = Math.floor(rest / fills.length);
    let extra = rest - share * fills.length;
    fills.forEach((child, idx) => {
      const add = share + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      fillW.set(child, Math.max(1, (mins[idx] ?? 0) + add));
    });
  }
  let h = 0;
  for (const [child, cw] of fixed) h = Math.max(h, measure(child, cw, opts));
  for (const child of autos)
    h = Math.max(h, measure(child, autoW.get(child) ?? 1, opts));
  for (const child of fills)
    h = Math.max(h, measure(child, fillW.get(child) ?? 1, opts));
  tree.height = h;
  return h;
}
