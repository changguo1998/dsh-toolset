// TUI/src/app/layout/measure.ts — Box 排版尺寸测量与矩形分配（规范见 SPEC.md §6）
//
// 接口冻结后的纯函数实现：measure 自底向上量尺寸（宽锁→高自由生长），
// allocate 自顶向下切矩形。不解析 markdown（fill 阶段的事），只按 displayWidth
// 折行/截断。复用既有 wrapLine/truncateToWidth/displayWidth 宽度原语。

import { wrapLine, truncateToWidth } from "../layout.ts";
import { displayWidth } from "./markdown.ts";
import type { Node, Box, Paragraph, Rect, Width, Height } from "./box.ts";

/** measure 约束：来自父链的可用宽上界（宽锁）。根：终端 cols */
export interface MeasureConstraint {
  maxW: number;
}

/** 单个节点实测尺寸（SizeTable.size 值） */
export interface MeasuredSize {
  /** 节点总宽（含 indent + prefix） */
  w: number;
  /** 自然高（内容决定） */
  h: number;
}

/** measure 产物：每个节点测量后的自然宽高 */
export interface SizeTable {
  /** 根节点引用，allocate 由它出发递归（避免重复解析文本） */
  root: Node;
  /** 根总宽 */
  w: number;
  /** 根自然高 */
  h: number;
  /** 子树实测（含自身），供 allocate 精确切分 */
  size: Map<Node, MeasuredSize>;
}

/** 段落正文折行；wrap=false 时单行截断 */
function wrapParagraph(text: string, width: number, wrap: boolean): string[] {
  if (!wrap) return [truncateToWidth(text, width)];
  return wrapLine(text, width);
}

/** 首行/续行可用宽与缩进（prefix 先占列） */
function paraWidthCtx(node: Paragraph) {
  const prefixW = node.prefix ? displayWidth(node.prefix.text) : 0;
  const indent = node.indent ?? 0;
  const hanging = node.hanging ?? indent;
  return { prefixW, indent, hanging };
}

/** height.fixed 声明覆盖测量高（v 排布 spacer/固定行高区用） */
function applyDeclaredHeight(node: Node, m: MeasuredSize): MeasuredSize {
  if (node.height?.mode === "fixed") return { w: m.w, h: node.height.rows };
  return m;
}

/** 测量单个 Paragraph（返回总宽与折行行数） */
function measureParagraph(node: Paragraph, maxW: number): MeasuredSize {
  const { prefixW, indent, hanging } = paraWidthCtx(node);
  const firstW = maxW - indent - prefixW; // 首行可用正文宽
  const contW = maxW - hanging; // 续行可用正文宽
  const wrap = node.wrap !== false;
  // 首行按 firstW 折、续行按 contW 折：拆首行，其余文本按续行宽重折（悬挂缩进）
  const rows: string[] = [];
  let remaining = node.text;
  const firstRows = wrapParagraph(
    remaining,
    Math.max(1, firstW),
    wrap && firstW > 0,
  );
  if (firstRows.length > 0) {
    rows.push(firstRows[0]!);
    remaining = firstRows.slice(1).join(""); // 首行放不下的并入续行续排
  }
  if (remaining !== "" || firstRows.length === 0) {
    rows.push(...wrapParagraph(remaining, Math.max(1, contW), wrap));
  }
  // 空文本：至少 1 行（空段落占行）
  if (rows.length === 0) rows.push("");
  // 总宽 = max(首行 overhead+首行宽, 续行 overhead(hanging)+续行最宽)
  const firstTotal = indent + prefixW + displayWidth(rows[0]!);
  const contTotal =
    hanging + Math.max(...rows.slice(1).map((r) => displayWidth(r)), 0);
  return { w: Math.max(firstTotal, contTotal), h: rows.length };
}

/** 分配优先级：越精确越高（fixed > min/max > ratio > auto > fill） */
function priorityOf(w: Width): number {
  switch (w.mode) {
    case "fixed":
      return 1;
    case "auto":
      return 4;
    case "fill":
      return 5;
    case "ratio":
      return 3;
  }
  // max/min 通过 min/max 字段表达，归 2
  return 2;
}

/** 子项声明宽度（无声明 → auto） */
function widthOf(node: Node): Width {
  return node.width ?? { mode: "auto" };
}

/**
 * 给 h 排布的子项按分配优先级切宽（返回每个 child 的分配宽）。
 * 规则（SPEC §6.5）：fixed 定值 → min/max 边界 → ratio 比例 → auto 内容宽（夹 max）→ fill 吃剩余；
 * 过度约束按 fill→auto→ratio→max→min→fixed 让路；宽底线 ≥ 1。
 */
function allocateWidths(
  children: Node[],
  totalW: number,
  natural: Map<Node, MeasuredSize>,
): { w: number; constrain: Width }[] {
  const result: { used: boolean; w: number; width: Width }[] = [];
  const widths = children.map(widthOf);
  let remaining = totalW;

  // 1. fixed：直接定值
  for (let i = 0; i < children.length; i++) {
    const w = widths[i]!;
    if (w.mode === "fixed") {
      const kw = Math.max(1, w.cols);
      result[i] = { used: true, w: kw, width: w };
      remaining -= kw;
    }
  }
  // 2. min/max-only 声明（含 auto/fill/ratio 携带的夹取界）：先标记，分配时应用
  // 3. ratio：基数取剩余（可分配宽），受 min/max 封顶
  {
    let ratioSum = 0;
    let ratioCount = 0;
    for (let i = 0; i < children.length; i++) {
      const w = widths[i]!;
      if (w.mode === "ratio" && !result[i]) {
        ratioSum += w.value;
        ratioCount++;
      }
    }
    if (ratioCount > 0 && remaining > 0) {
      // value 是分数（状态列 1/3 = value 1/3）；多个 ratio 按 value 和归一（通常 Σ=1）
      // 基数取容器总宽（SPEC §6.5），实际受可分配剩余封顶
      const base = totalW;
      const denom = ratioSum > 1 ? ratioSum : 1; // 单 ratio 时 value 即分数本身
      for (let i = 0; i < children.length; i++) {
        const w = widths[i]!;
        if (w.mode === "ratio" && !result[i]) {
          let kw = Math.floor((base * w.value) / denom);
          if (w.max !== undefined) kw = Math.min(kw, w.max); // 先上限
          if (w.min !== undefined) kw = Math.max(kw, w.min); // 再保底（min>max 时 min 赢）
          kw = Math.max(1, kw);
          if (kw > remaining) kw = Math.max(1, remaining); // 受可分配宽封顶
          result[i] = { used: true, w: kw, width: w };
          remaining -= kw;
        }
      }
    }
  }
  // 4. auto：以 maxW = min(剩余, max) 为折行上界量内容宽；min 保底
  const autoIdx: number[] = [];
  for (let i = 0; i < children.length; i++) {
    const w = widths[i]!;
    if (w.mode === "auto" && !result[i]) autoIdx.push(i);
  }
  for (const i of autoIdx) {
    const wd = widths[i]! as Extract<Width, { mode: "auto" }>;
    const nat = natural.get(children[i]!)!;
    const upper =
      wd.max !== undefined ? Math.min(remaining, wd.max) : remaining;
    let kw = Math.min(nat.w, Math.max(1, upper));
    if (wd.min !== undefined) kw = Math.max(kw, wd.min);
    result[i] = { used: true, w: kw, width: wd };
    remaining -= kw;
  }
  const fillIdx: number[] = [];
  for (let i = 0; i < children.length; i++) {
    const w = widths[i]!;
    if (w.mode === "fill" && !result[i]) fillIdx.push(i);
  }
  const pool = Math.max(0, remaining);
  if (fillIdx.length > 0) {
    const share = Math.floor(pool / fillIdx.length);
    let carry = pool - share * fillIdx.length;
    for (let k = 0; k < fillIdx.length; k++) {
      const i = fillIdx[k]!;
      const wd = widths[i]! as Extract<Width, { mode: "fill" }>;
      let kw = share + (carry > 0 ? 1 : 0);
      carry -= carry > 0 ? 1 : 0;
      if (wd.max !== undefined) kw = Math.min(kw, wd.max); // 先上限
      if (wd.min !== undefined) kw = Math.max(kw, wd.min); // 再保底（min>max 时 min 赢）
      result[i] = { used: true, w: kw, width: wd }; // 吃剩余者无剩余得 0（不主张底线）
    }
  }
  // 无声明（无 width）的默认 auto：也按 auto 处理
  for (let i = 0; i < children.length; i++) {
    if (!result[i]) {
      const nat = natural.get(children[i]!)!;
      const kw = Math.max(1, Math.min(nat.w, Math.max(1, remaining)));
      result[i] = { used: true, w: kw, width: { mode: "auto" } };
      remaining -= kw;
    }
  }
  // 过度约束：若 remaining < 0，按让路顺序压缩（fill→auto→ratio→max→min→fixed）
  if (remaining < 0) {
    const order = [5, 4, 3, 2, 2, 1]; // fill, auto, ratio, max, min, fixed
    for (const p of order) {
      if (remaining >= 0) break;
      for (let i = 0; i < children.length; i++) {
        if (remaining >= 0) break;
        const w = widths[i]!;
        if (priorityOf(w) !== p || result[i]!.w <= 1) continue;
        const cut = Math.min(result[i]!.w - 1, -remaining);
        result[i]!.w -= cut;
        remaining += cut;
      }
    }
  }
  // 底线强于一切：非 fill 子项保 ≥1（fill 是「吃剩余者」，无剩余时得 0 合法）
  for (let i = 0; i < children.length; i++) {
    const w = widths[i]!;
    if (w.mode !== "fill" && result[i]!.w < 1) result[i]!.w = 1;
  }
  return result.map(
    (r) => ({ w: r.w, constrain: r.width }) as { w: number; constrain: Width },
  );
}

/** 递归测量（自底向上）；返回节点自身尺寸，并写入 st.size */
function measureNode(
  node: Node,
  c: MeasureConstraint,
  st: { size: Map<Node, MeasuredSize> },
): MeasuredSize {
  if (node.kind === "text") {
    const m = applyDeclaredHeight(node, measureParagraph(node, c.maxW));
    st.size.set(node, m);
    return m;
  }
  const box = node as Box;
  if (box.direction === "v") {
    let h = 0;
    let w = 0;
    let base = c.maxW;
    for (let i = 0; i < box.children.length; i++) {
      // 若子项声明了高度固定，其宽度仍受容器同宽约束
      const m = measureNode(box.children[i]!, { maxW: base }, st);
      w = Math.max(w, m.w);
      h += m.h;
      if (i < box.children.length - 1 && box.separator) h += 1;
    }
    const m = applyDeclaredHeight(box, { w: Math.max(0, w), h });
    st.size.set(box, m);
    return m;
  }
  // h 排布
  let childMaxH = 0;
  // 第一遍：fixed/ratio/auto 先按自然宽测量（auto 以 max 为上界）
  for (let i = 0; i < box.children.length; i++) {
    const child = box.children[i]!;
    const wd = widthOf(child);
    const upper =
      wd.mode === "auto" && wd.max !== undefined
        ? Math.min(c.maxW, wd.max)
        : c.maxW;
    measureNode(child, { maxW: Math.max(1, upper) }, st); // 副作用：写入 st.size 供第二遍取高
  }
  // 第二遍：按优先级分配宽度
  const allocated = allocateWidths(box.children, c.maxW, st.size);
  let filledW = 0;
  for (let i = 0; i < box.children.length; i++) {
    const child = box.children[i]!;
    const aw = allocated[i]!.w;
    // 全部子项以分配宽重测高度（fixed/ratio 段落折行也受分配宽影响）
    const m = measureNode(child, { maxW: Math.max(1, aw) }, st);
    childMaxH = Math.max(childMaxH, m.h);
    filledW += aw;
  }
  const m = applyDeclaredHeight(box, { w: filledW, h: childMaxH });
  st.size.set(box, m);
  return m;
}

/**
 * 测量整棵 Box 树。返回 SizeTable（含 root 与全部子节点实测）。
 * 循环依赖注意：本模块从 layout.ts 导入宽度原语；下一接线里程碑需先
 * 把共享原语迁到中立模块再双向引用（TASKS.md 已记录）。
 */
export function measure(root: Node, c: MeasureConstraint): SizeTable {
  const size = new Map<Node, MeasuredSize>();
  const r = measureNode(root, c, { size });
  return { root, w: r.w, h: r.h, size };
}

/** h 排布递归切宽；v 排布递归切高；输出每个节点的最终矩形 */
function allocateNode(
  node: Node,
  rect: Rect,
  st: SizeTable,
  out: Map<Node, Rect>,
): void {
  out.set(node, rect);
  if (node.kind === "text") return;
  const box = node as Box;
  if (box.direction === "h") {
    const widths = allocateWidths(box.children, rect.w, st.size);
    let x = rect.x;
    for (let i = 0; i < box.children.length; i++) {
      const child = box.children[i]!;
      const w = widths[i]!.w;
      allocateNode(child, { x, y: rect.y, w, h: rect.h }, st, out);
      x += w;
    }
    return;
  }
  // v 排布：同宽，逐个切高；separator 占 1 行
  let y = rect.y;
  let remainingH = rect.h;
  // 各子项高度主张：fixed 按声明行数；fill 吃剩余；无声明取测量高（auto）
  const heights: number[] = [];
  const prio: number[] = []; // 让路优先级：fill=5, auto=4, fixed=1
  let claim = 0; // 非 fill 主张和
  let fillCount = 0;
  for (let i = 0; i < box.children.length; i++) {
    const child = box.children[i]!;
    const hg = child.height;
    if (hg?.mode === "fixed") {
      heights[i] = hg.rows;
      prio[i] = 1;
      claim += hg.rows;
    } else if (hg?.mode === "fill") {
      heights[i] = -1; // fill 占位，稍后分配
      prio[i] = 5;
      fillCount++;
    } else {
      const h = st.size.get(child)?.h ?? 0;
      heights[i] = h;
      prio[i] = 4;
      claim += h;
    }
  }
  // 预算 = rect.h - separator 行数；不足时按让路顺序压缩（auto → fixed）
  const sepWide =
    box.children.length > 1 && box.separator ? box.children.length - 1 : 0;
  const avail = Math.max(0, remainingH - sepWide);
  if (claim > avail) {
    let deficit = claim - avail;
    const shrinkOrder = [4, 1]; // auto（测量）先让，fixed 最后
    for (const p of shrinkOrder) {
      if (deficit <= 0) break;
      for (let i = 0; i < box.children.length; i++) {
        if (deficit <= 0) break;
        if (prio[i] !== p) continue;
        const cut = Math.min(heights[i]!, deficit);
        heights[i]! -= cut;
        deficit -= cut;
      }
    }
  }
  // fill 平分剩余（无剩余得 0）
  let fillPool = Math.max(
    0,
    avail - heights.filter((_, i) => prio[i] !== 5).reduce((a, b) => a + b, 0),
  );
  for (let i = 0; i < box.children.length; i++) {
    if (heights[i] === -1) {
      heights[i] = fillCount > 0 ? Math.floor(fillPool / fillCount) : 0;
      fillPool -= heights[i]!;
      fillCount--;
    }
  }
  for (let i = 0; i < box.children.length; i++) {
    const child = box.children[i]!;
    const h = Math.max(0, heights[i] ?? 0);
    allocateNode(child, { x: rect.x, y, w: rect.w, h }, st, out);
    y += h;
    remainingH -= h;
    if (i < box.children.length - 1 && box.separator) {
      y += 1;
      remainingH -= 1;
    }
  }
}

/** 按 SizeTable 从根递归分配矩形；返回每个节点的最终矩形 */
export function allocate(st: SizeTable, rect: Rect): Map<Node, Rect> {
  const out = new Map<Node, Rect>();
  allocateNode(st.root, rect, st, out);
  return out;
}

// 展开未用类型避免 noUnusedLocals 干净
export type { Width, Height };
