// TUI/src/app/layout/measure.ts — Box 布局：自顶向下分配与自底向上测量交替，循环到尺寸稳定
//
// 尺寸真相在节点自身（width / height）：allocate 负责“分”，measure 负责“量”，
// 两者轮流执行；`widthLocked` / `heightLocked` 一旦置位，后续写入跳过。
// 分配按 fixed > ratio > auto > fill 的顺序更新，每次只推一种。

import { wrapLine, truncateToWidth } from "./primitives.ts";
import { displayWidth } from "./markdown.ts";
import type {
  Node,
  Box,
  Paragraph,
  StyledText,
  Rect,
  WidthStyle,
  HeightStyle,
} from "./box.ts";

/** 轮数上限：先放宽到几十轮观察收敛（每轮只推进一种类型） */
const MAX_PASS = 64;

const WIDTH_ORDER: WidthStyle[] = ["fixed", "ratio", "auto", "fill"];

/** 满宽铺底量出的 auto 自然宽（参考值，分配时只作上限） */
let naturalWidths = new WeakMap<Node, number>();
/** 宽度已由 measure 量过的节点（区分“分配占位值”与“自然宽”） */
let measuredWidths = new WeakSet<Node>();
/** 宽度已由 allocate 正式分配过的节点（种子铺宽不算） */
let allocatedWidths = new WeakSet<Node>();

// ---------------- 入口 ----------------

/** 布局整棵树：根宽锁为 maxW，返回每个节点的最终矩形（尺寸同时写回节点） */
export function layout(root: Node, maxW: number): Map<Node, Rect> {
  naturalWidths = new WeakMap<Node, number>();
  measuredWidths = new WeakSet<Node>();
  allocatedWidths = new WeakSet<Node>();
  const width = Math.max(1, Math.floor(maxW));
  root.width = width;
  root.widthLocked = true;
  if (root.heightStyle === "fixed") {
    root.height = Math.max(1, root.heightFixed ?? 1);
    root.heightLocked = true;
  }
  for (let pass = 0; pass < MAX_PASS; pass++) {
    // 每轮从同一初始态重来：全部铺满宽，再由分配与测量各自收敛
    seedWidth(root, width);
    const before = snapshot(root);
    allocateNode(root);
    measurePass(root, undefined, true, true);
    if (pass > 0 && isSame(before, root)) break;
  }
  const rects = new Map<Node, Rect>();
  collectRects(root, 0, 0, rects);
  return rects;
}

/** 铺宽：所有节点宽度重置为 maxW；已锁定宽度的节点保持其值 */
function seedWidth(node: Node, width: number): void {
  if (node.widthLocked !== true) node.width = width;
  if (node.kind === "box") {
    for (const child of node.children) seedWidth(child, width);
  }
}

/** 取自然宽参考值（满宽铺底时记录；未记录则按满宽现量一次） */
function naturalWidthOf(node: Node, maxW: number): number {
  const hit = naturalWidths.get(node);
  if (hit !== undefined) return hit;
  const natural = measureWidthAt(node, maxW);
  naturalWidths.set(node, natural);
  return natural;
}

/** 在给定可用宽下量节点自然宽（叶子按折行、Box 按子项宽度累加） */
function measureWidthAt(node: Node, maxW: number): number {
  if (node.kind === "box") {
    const box = node as Box;
    const sep =
      box.children.length > 1 && box.separator ? box.children.length - 1 : 0;
    let w = 0;
    for (const c of box.children) {
      const cw = measureWidthAt(c, maxW);
      w = box.direction === "h" ? w + cw : Math.max(w, cw);
    }
    return w + (box.direction === "h" ? sep : 0);
  }
  const { prefixW, suffixW, indent, hanging } = paraWidthCtx(node);
  const text = node.kind === "styled" ? styledText(node) : node.text;
  const firstBase = Math.max(1, maxW - indent - prefixW - suffixW);
  const balance = node.balance === true && !text.includes("\n");
  const wrapW = balance ? balancedWidthFor(text, firstBase) : firstBase;
  const rows = paragraphRows(text, wrapW, node.wrap !== false);
  const firstTotal = indent + prefixW + displayWidth(rows[0] ?? "");
  const contTotal =
    hanging + Math.max(0, ...rows.slice(1).map((r) => displayWidth(r)));
  return Math.max(firstTotal, contTotal) + suffixW;
}

/** 每个容器自己推进：取自己第一个“还有子项未锁定”的类型；全锁则跑 fill */
function firstPendingWidth(box: Box): WidthStyle | undefined {
  for (const style of WIDTH_ORDER) {
    if (
      box.children.some(
        (c) => widthStyleOf(c) === style && c.widthLocked !== true,
      )
    ) {
      return style;
    }
  }
  return undefined;
}

const HEIGHT_ORDER: HeightStyle[] = ["fixed", "auto", "fill"];

function firstPendingHeight(box: Box): HeightStyle | undefined {
  for (const style of HEIGHT_ORDER) {
    if (
      box.children.some(
        (c) => heightStyleOf(c) === style && c.heightLocked !== true,
      )
    ) {
      return style;
    }
  }
  return undefined;
}

// ---------------- 分配（自顶向下） ----------------

function widthStyleOf(node: Node): WidthStyle {
  return node.widthStyle ?? "auto";
}

function heightStyleOf(node: Node): HeightStyle {
  return node.heightStyle ?? "auto";
}

/** 是否所有“更早的宽度类型”都已锁定（顺序 fixed > ratio > auto > fill） */
function earlierWidthLocked(box: Box, style: WidthStyle): boolean {
  const idx = WIDTH_ORDER.indexOf(style);
  return box.children.every((c) => {
    const i = WIDTH_ORDER.indexOf(widthStyleOf(c));
    return i >= idx || c.widthLocked === true;
  });
}

/** 分配：每个容器按自己的阶段推进一种类型，然后递归子项 */
function allocateNode(node: Node): void {
  if (node.kind !== "box") return;
  const box = node as Box;
  // 固定高度：任何方向的子项都先按声明值落地（高度链的 fixed 阶段）
  for (const child of box.children) {
    if (heightStyleOf(child) !== "fixed" || child.heightLocked === true)
      continue;
    child.height = Math.max(1, child.heightFixed ?? 1);
    child.heightLocked = true;
  }
  if (box.direction === "h") {
    const style = firstPendingWidth(box) ?? "fill";
    allocateWidths(box, style);
  } else {
    // 纵向容器：子项宽度随父；父宽还没定下来时先给父宽，定下来后直接锁定
    for (const child of box.children) {
      if (child.widthLocked === true || box.width === undefined) continue;
      child.width = box.width;
      allocatedWidths.add(child);
      if (box.widthLocked === true) child.widthLocked = true;
    }
    const style = firstPendingHeight(box) ?? "fill";
    allocateHeights(box, style);
  }
  for (const child of box.children) allocateNode(child);
}

function clampWidth(node: Node, width: number): number {
  let w = Math.max(1, Math.floor(width));
  if (node.widthMax !== undefined) w = Math.min(w, node.widthMax);
  if (node.widthMin !== undefined) w = Math.max(w, node.widthMin);
  return w;
}

/** 容器内 fixed 子项定值之和 */
function fixedWidthSum(box: Box): number {
  let sum = 0;
  for (const c of box.children) {
    if (widthStyleOf(c) !== "fixed") continue;
    sum += Math.max(1, c.widthFixed ?? 1);
  }
  return sum;
}

function allocateWidths(box: Box, style: WidthStyle): void {
  const total = box.width ?? 0;
  const sep =
    box.children.length > 1 && box.separator ? box.children.length - 1 : 0;

  if (style === "fixed") {
    for (const c of box.children) {
      if (widthStyleOf(c) !== "fixed" || c.widthLocked === true) continue;
      c.width = clampWidth(c, c.widthFixed ?? 1);
      allocatedWidths.add(c);
      c.widthLocked = true;
    }
    return;
  }

  if (style === "ratio") {
    let sum = 0;
    for (const c of box.children) {
      if (widthStyleOf(c) === "ratio") sum += c.widthRatio ?? 0;
    }
    const denom = sum > 1 ? sum : 1;
    const contentW = Math.max(0, total - sep - fixedWidthSum(box));
    // 压缩余量：fixed 定值之后若超出容器，ratio 让到「容器 - 其余类型自然宽」，但不破 min
    const othersW = box.children
      .filter((c) => {
        const s = widthStyleOf(c);
        return s === "auto" || s === "fill";
      })
      .reduce((acc, c) => {
        // auto / fill 让路时只保证各自的 min（自然宽不占预算）
        return acc + (c.widthMin ?? 0);
      }, 0);
    const budget = Math.max(0, contentW - othersW);
    let ratioTotal = 0;
    for (const c of box.children) {
      if (widthStyleOf(c) !== "ratio" || c.widthLocked === true) continue;
      ratioTotal += (contentW * (c.widthRatio ?? 0)) / denom;
    }
    const shrink = ratioTotal > budget ? budget / ratioTotal : 1;
    for (const c of box.children) {
      if (widthStyleOf(c) !== "ratio" || c.widthLocked === true) continue;
      const raw = ((contentW * (c.widthRatio ?? 0)) / denom) * shrink;
      c.width = clampWidth(c, raw);
      allocatedWidths.add(c);
      // 父宽锁定后，比例宽度才算最终值
      if (box.widthLocked === true) c.widthLocked = true;
    }
    return;
  }

  if (style === "auto") {
    // 预算 = 总宽 - fixed 定值 - ratio 宽度 - fill 的保底下限
    const rest =
      fixedWidthSum(box) +
      box.children
        .filter((c) => widthStyleOf(c) === "ratio")
        .reduce((s, c) => s + (c.width ?? 0), 0);
    const reserved = box.children
      .filter((c) => widthStyleOf(c) === "fill")
      .reduce((s, c) => s + (c.widthMin ?? 0), 0);
    // auto 子项平摊预算（min 先保底，再按剩余均分）；自然宽只作上限
    const autos = box.children.filter(
      (c) => widthStyleOf(c) === "auto" && c.widthLocked !== true,
    );
    const pool = Math.max(0, total - sep - rest - reserved);
    // auto：有自然宽就取自然宽（受池子上限）；还没有自然宽时先按池子均分占位
    const natural = autos.map((c) => naturalWidths.get(c));
    const known = autos.map(
      (c) => measuredWidths.has(c) && naturalWidths.has(c),
    );
    autos.forEach((c, i) => {
      if (known[i]) {
        c.width = clampWidth(c, Math.min(natural[i]!, pool));
        // 容器还要等子项宽度全部锁定，否则自然宽还会变
        const childrenLocked =
          c.kind !== "box" ||
          (c as Box).children.every((g) => g.widthLocked === true);
        if (
          box.widthLocked === true &&
          earlierWidthLocked(box, "auto") &&
          childrenLocked
        ) {
          c.widthLocked = true;
        }
      } else {
        // 未量过：均分池子占位，等 measure 给出自然宽
        c.width = clampWidth(c, Math.floor(pool / autos.length));
      }
      allocatedWidths.add(c);
    });
    return;
  }

  // fill：剩余均分；更早类型全锁后可锁
  const fills = box.children.filter((c) => widthStyleOf(c) === "fill");
  if (fills.length === 0) return;
  const rest = box.children
    .filter((c) => widthStyleOf(c) !== "fill")
    .reduce((s, c) => s + (c.width ?? 0), 0);
  const remaining = Math.max(0, total - sep - rest);
  const share = Math.floor(remaining / fills.length);
  let carry = remaining - share * fills.length;
  for (const c of fills) {
    if (c.widthLocked === true) continue;
    const extra = carry > 0 ? 1 : 0;
    if (carry > 0) carry -= 1;
    c.width = Math.max(c.widthMin ?? 0, share + extra);
    allocatedWidths.add(c);
    if (box.widthLocked === true && earlierWidthLocked(box, "fill")) {
      c.widthLocked = true;
    }
  }
}

function allocateHeights(box: Box, style: HeightStyle): void {
  const total = box.height ?? 0;
  const sep =
    box.children.length > 1 && box.separator ? box.children.length - 1 : 0;

  if (style === "fixed") {
    for (const c of box.children) {
      if (heightStyleOf(c) !== "fixed" || c.heightLocked === true) continue;
      c.height = Math.max(1, c.heightFixed ?? 1);
      c.heightLocked = true;
    }
    return;
  }
  if (style === "auto") return; // 内容高由 measure 写，稳定后在 measure 里锁定

  const fills = box.children.filter((c) => heightStyleOf(c) === "fill");
  if (fills.length === 0) return;
  const rest = box.children
    .filter((c) => heightStyleOf(c) !== "fill")
    .reduce((s, c) => s + (c.height ?? 0), 0);
  const remaining = Math.max(0, total - sep - rest);
  const share = Math.floor(remaining / fills.length);
  let carry = remaining - share * fills.length;
  for (const c of fills) {
    if (c.heightLocked === true) continue;
    const extra = carry > 0 ? 1 : 0;
    if (carry > 0) carry -= 1;
    c.height = share + extra;
    if (box.heightLocked === true) c.heightLocked = true;
  }
}

// ---------------- 测量（自底向上） ----------------

/** 写自动宽度：只写值并记录自然宽，锁定交给上层按条件判断 */
function writeAutoWidth(node: Node, width: number): void {
  if (node.widthLocked === true || widthStyleOf(node) !== "auto") return;
  // 空内容的自然宽是 0（tail / 空段不主张列），其余至少 1 列
  node.width = Math.max(0, width);
  measuredWidths.add(node);
  if (!naturalWidths.has(node)) naturalWidths.set(node, node.width);
}

function measurePass(
  node: Node,
  parentDir: "h" | "v" | undefined,
  parentLocked: boolean,
  parentWidthKnown: boolean,
): void {
  if (node.kind === "box") {
    const box = node as Box;
    for (const child of box.children) {
      measurePass(
        child,
        box.direction,
        box.widthLocked === true,
        box.width !== undefined,
      );
    }
    const sep =
      box.children.length > 1 && box.separator ? box.children.length - 1 : 0;
    const widthsKnown = box.children.every((c) => c.width !== undefined);
    const heightsKnown = box.children.every((c) => c.height !== undefined);
    if (heightsKnown && heightStyleOf(box) === "auto") {
      let h = 0;
      if (box.direction === "v") {
        for (const c of box.children) h += c.height ?? 0;
        h += sep;
      } else {
        for (const c of box.children) h = Math.max(h, c.height ?? 0);
      }
      if (box.heightLocked !== true) {
        box.height = h;
        if (box.children.every((c) => c.heightLocked === true)) {
          box.heightLocked = true;
        }
      }
    }
    if (
      parentDir === "h" &&
      widthStyleOf(box) === "auto" &&
      box.widthLocked !== true &&
      widthsKnown
    ) {
      let w = 0;
      if (box.direction === "v") {
        for (const c of box.children) w = Math.max(w, c.width ?? 0);
      } else {
        for (const c of box.children) w += c.width ?? 0;
        w += sep;
      }
      writeAutoWidth(box, w);
      // 容器 auto 宽锁定：父宽已锁 + 更早类型全锁 + 子项宽度全部锁定
      if (
        parentLocked &&
        earlierWidthLocked(box, "auto") &&
        box.children.every((c) => c.widthLocked === true)
      ) {
        box.widthLocked = true;
      }
    }
    return;
  }
  measureLeaf(node, parentDir, parentWidthKnown);
}

function measureLeaf(
  node: Paragraph | StyledText,
  parentDir: "h" | "v" | undefined,
  parentWidthKnown: boolean,
): void {
  // 宽度未知时不量：折行宽没有意义，也不锁定
  if (node.width === undefined) return;
  const width = Math.max(1, node.width);
  const { prefixW, suffixW, indent, hanging } = paraWidthCtx(node);
  const text = node.kind === "styled" ? styledText(node) : node.text;
  const wrap = node.wrap !== false;
  const balance = node.balance === true && !text.includes("\n");
  const body = Math.max(1, width - suffixW);
  const firstW = Math.max(1, body - indent - prefixW);
  const contW = Math.max(1, body - hanging);
  // 平衡折行：按收窄列宽折；Paragraph 不拆物理行（\n 当普通字符，与 fill 一致），
  // StyledText 才按 \n 切物理行
  const rows = balance
    ? paragraphRows(text, balancedWidthFor(text, firstW), wrap)
    : node.kind === "text"
      ? paragraphRowsNoSplit(text, firstW, contW, wrap)
      : paragraphRows(text, firstW, wrap);
  if (node.heightLocked !== true && heightStyleOf(node) === "auto") {
    node.height = rows.length;
    // 宽度锁定后内容高才算最终；平衡折行反过来先锁高，下一轮再锁宽
    if (node.widthLocked === true || node.balance === true) {
      node.heightLocked = true;
    }
  }
  if (parentDir !== "h") return;
  // 行内自然宽 = 最长行（首行含 indent+prefix，续行含 hanging）+ suffix
  const firstTotal = indent + prefixW + displayWidth(rows[0] ?? "");
  const contTotal =
    hanging + Math.max(0, ...rows.slice(1).map((r) => displayWidth(r)));
  const rawW = text === "" ? 0 : Math.max(firstTotal, contTotal) + suffixW;
  // min / max 是硬约束：自然宽先按声明夹取
  const contentW = clampWidth(node, rawW);
  writeAutoWidth(node, contentW);
  // 叶子 auto 宽锁定：父宽已知 + 宽度已被正式分配过 + 平衡折行要求高度已锁
  if (
    widthStyleOf(node) === "auto" &&
    parentWidthKnown &&
    allocatedWidths.has(node) &&
    (node.balance !== true || node.heightLocked === true)
  ) {
    node.widthLocked = true;
  }
}

/** 段落正文折行；wrap=false 时单行截断 */
function wrapParagraph(text: string, width: number, wrap: boolean): string[] {
  if (!wrap) return [truncateToWidth(text, width)];
  return wrapLine(text, width);
}

/** 首行/续行可用宽与缩进（prefix/suffix 先占列）；Paragraph 与 StyledText 共享 */
function paraWidthCtx(node: Paragraph | StyledText) {
  const prefixW = node.prefix ? displayWidth(node.prefix.text) : 0;
  const suffixW = node.suffix ? displayWidth(node.suffix.text) : 0;
  const indent = node.indent ?? 0;
  const hanging = node.hanging ?? indent;
  return { prefixW, suffixW, indent, hanging };
}

/** 预样式中段的拼接文本（显示宽度测量用；样式忽略） */
function styledText(node: StyledText): string {
  return node.segments.map((s) => s.text).join("");
}

/** 按物理行（\n 切分）折行，产出显示行列表 */
function paragraphRows(
  text: string,
  wrapWidth: number,
  wrap: boolean,
): string[] {
  const rows: string[] = [];
  // 全部按同一折行宽折（与 fill 行内 markdown 折行口径一致）
  for (const line of text.split("\n")) {
    if (line === "") {
      rows.push("");
      continue;
    }
    rows.push(...wrapParagraph(line, Math.max(1, wrapWidth), wrap));
  }
  if (rows.length === 0) rows.push("");
  return rows;
}

/** Paragraph 折行：\n 是普通字符（与 fill 的 assistant/plain 口径一致），首行与续行同宽 */
function paragraphRowsNoSplit(
  text: string,
  wrapWidth: number,
  contWidth: number,
  wrap: boolean,
): string[] {
  void contWidth;
  const rows = wrapParagraph(text, Math.max(1, wrapWidth), wrap);
  if (rows.length === 0) rows.push("");
  return rows;
}

/** 平衡折行宽度：R = ceil(L / Cmax)，C = ceil(L / R)，宽字符修正。 */
function balancedWidthFor(text: string, maxWidth: number): number {
  if (text.includes("\n") || maxWidth <= 0) return maxWidth;
  const rowsAt = (w: number): number =>
    wrapParagraph(text, Math.max(1, w), true).length;
  const rows = rowsAt(maxWidth);
  if (rows <= 1) return maxWidth;
  const total = displayWidth(text);
  let width = Math.max(1, Math.ceil(total / rows));
  while (width < maxWidth && rowsAt(width) > rows) width += 1;
  return width;
}

// ---------------- 收敛与矩形 ----------------

function snapshot(node: Node, out: number[] = []): number[] {
  out.push(node.width ?? -1, node.height ?? -1);
  if (node.kind === "box") {
    for (const child of node.children) snapshot(child, out);
  }
  return out;
}

function isSame(before: number[], node: Node): boolean {
  const now = snapshot(node);
  if (now.length !== before.length) return false;
  return now.every((v, i) => v === before[i]);
}

/** 从根向下落矩形（位置只依赖最终尺寸） */
function collectRects(
  node: Node,
  x: number,
  y: number,
  out: Map<Node, Rect>,
): void {
  const w = Math.max(0, node.width ?? 0);
  const h = Math.max(0, node.height ?? 0);
  out.set(node, { x, y, w, h });
  if (node.kind !== "box") return;
  const box = node as Box;
  if (box.direction === "h") {
    let cx = x;
    for (const child of box.children) {
      collectRects(child, cx, y, out);
      cx += (child.width ?? 0) + (box.separator ? 1 : 0);
    }
  } else {
    let cy = y;
    for (const child of box.children) {
      collectRects(child, x, cy, out);
      cy += (child.height ?? 0) + (box.separator ? 1 : 0);
    }
  }
}
