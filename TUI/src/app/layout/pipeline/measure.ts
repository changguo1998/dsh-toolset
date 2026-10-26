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
import type { ToolUnit } from "./tool-units.ts";

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
  // h 容器相邻子项之间的分隔符同样占列（与 measureH 的 separatorWidth 同口径）
  const sepW =
    child.direction === "h" && child.separator !== undefined
      ? displayWidth(sepChar(child.separator)) *
        Math.max(0, child.children.length - 1)
      : 0;
  const inner = Math.max(1, budget - decor - sepW);
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
    return Math.min(budget, decor + sepW + fixedSum + autoMax);
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
function expandCode(tree: Node): void {
  const code = tree.code!;
  tree.code = undefined;
  tree.direction = "v";
  tree.separator = undefined;
  tree.children = codeLines(code);
}

/** 表格数据行：行盒只带 `separator`（列竖线），格本身先不带宽度（列宽由 grid pass 写） */
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

/** §5 展开表格：`Box(v, grid)[表头行, ═ 横线, 数据行…]`（列宽由 grid pass 定） */
function expandTable(tree: Node): void {
  const table = tree.table!;
  tree.table = undefined;
  tree.direction = "v";
  tree.grid = true;
  const ncols = table.header.length;
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

/**
 * 网格列对齐（`grid: true`）：先按列序号取各行格的**自然宽**最大值，再用 `fitCols`
 * 定列宽，最后写回每个行子项的 `widthFixed`。横线行的 `fill` 盒也照写同宽，
 * 使 `fillWith` 铺出的线段与列边界严丝合缝。
 */
function alignGridColumns(
  tree: Node,
  width: number,
  opts: MeasureOptions,
): void {
  const rows = tree.children.filter(
    (c): c is Node => !isLeaf(c) && c.direction === "h",
  );
  if (rows.length === 0) return;
  const ncols = rows.reduce((m, r) => Math.max(m, r.children.length), 0);
  if (ncols === 0) return;
  const sepW = Math.max(...rows.map((r) => separatorWidth(r)));
  const natural = Array.from({ length: ncols }, () => 1);
  for (const row of rows) {
    row.children.forEach((cell, j) => {
      // `fill` 盒是横线段，不参与自然宽
      if ((cell.widthStyle ?? "auto") === "fill") return;
      natural[j] = Math.max(natural[j]!, naturalHWidth(cell, width, opts));
    });
  }
  const cols = fitCols(natural, Math.max(1, width - sepW));
  const widths = cols ?? natural.map(() => 1);
  for (const row of rows) {
    row.children.forEach((cell, j) => {
      const wj = widths[j];
      if (wj === undefined) return;
      cell.widthStyle = "fixed";
      cell.widthFixed = wj;
    });
  }
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
  if (tree.code !== undefined) expandCode(tree); // §5 展开：载荷 → 结构
  if (tree.table !== undefined) expandTable(tree);
  // 表格网格：列宽必须先定，再按列宽量子项（否则各行的格宽度互不相同）
  if (tree.grid === true)
    alignGridColumns(
      tree,
      Math.max(
        1,
        w - prefixWidthOf(tree, opts.vw) - suffixWidthOf(tree, opts.vw),
      ),
      opts,
    );
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
  const children = tree.children;
  // 宽度按**子项下标**记录（同一叶对象出现在多个槽位时也不会互相覆盖）
  const widths = new Array<number>(children.length).fill(1);
  const autos: number[] = [];
  const fills: number[] = [];
  let fixedSum = 0;
  children.forEach((child, i) => {
    const style = child.widthStyle ?? "auto";
    if (style === "fixed" || (child.widthFixed ?? 0) > 0) {
      const cw = Math.max(1, child.widthFixed ?? 1);
      widths[i] = cw;
      fixedSum += cw;
    } else if (style === "fill") {
      fills.push(i);
    } else {
      autos.push(i);
    }
  });
  // fill 的 widthMin 是先占位的保底：auto 只能分配 fixed 与 fill 保底之外的剩余列，
  // 否则 auto 的自然宽会连同保底一起吃掉，合计超过容器宽（用户块正文曾因此超 2 列）
  const fillMin = fills.reduce(
    (a, i) => a + Math.max(0, children[i]!.widthMin ?? 0),
    0,
  );
  // auto 自然宽：文本叶 = min(展示宽 + 前缀/后缀, 剩余)；带 balance 的叶取剩余（尽力均摊）
  let remaining = Math.max(0, avail - fixedSum - fillMin);
  for (const i of autos) {
    const natural = naturalHWidth(children[i]!, remaining, opts);
    const cw = Math.max(1, Math.min(natural, Math.max(1, remaining)));
    widths[i] = cw;
    remaining = Math.max(0, remaining - cw);
  }
  // fill：各给 widthMin 保底；剩余列在多个 fill 之间均分（余数给靠前的），
  // 只有一个 fill 时即「吃下全部剩余」
  if (fills.length > 0) {
    const rest = Math.max(0, remaining);
    const share = Math.floor(rest / fills.length);
    let extra = rest - share * fills.length;
    fills.forEach((i) => {
      const add = share + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      widths[i] = Math.max(1, Math.max(0, children[i]!.widthMin ?? 0) + add);
    });
  }
  let h = 0;
  children.forEach((child, i) => {
    h = Math.max(h, measure(child, widths[i] ?? 1, opts));
  });
  tree.height = h;
  return h;
}
