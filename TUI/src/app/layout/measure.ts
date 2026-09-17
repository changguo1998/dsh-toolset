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

/** 子项声明宽度（无声明 → auto） */
function widthOf(node: Node): Width {
  return node.width ?? { mode: "auto" };
}

/** 给 h 排布的子项按分配优先级切宽（SPEC §6.5）。
 * 返回每个 child 的分配宽。优先级：fixed 定值 → min/max 边界 → ratio
 * 分数 → auto 内容宽（夹 max）→ fill 吃剩余；过度约束按
 * fill→auto→ratio→min-max→fixed 让路；宽底线 ≥1（fill 可 0）。 */
function allocateWidths(
  children: Node[],
  totalW: number,
  natural: Map<Node, MeasuredSize>,
): { w: number; constrain: Width }[] {
  const result: { w: number; width: Width }[] = [];
  const widths = children.map(widthOf);
  let remaining = totalW;

  // 1. fixed：直接定值，不可让
  for (let i = 0; i < children.length; i++) {
    const w = widths[i]!;
    if (w.mode === "fixed") {
      const kw = Math.max(1, w.cols);
      result[i] = { w: kw, width: w };
      remaining -= kw;
    }
  }
  // 2. ratio：value 为容器分数（1/3=三分之一），基数取容器总宽、
  //    受可分配剩余封顶；仅 Σvalue>1 时归一（SPEC §6.5 冻结语义）
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
      const denom = ratioSum > 1 ? ratioSum : 1; // 单 ratio value 即分数
      for (let i = 0; i < children.length; i++) {
        const w = widths[i]!;
        if (w.mode === "ratio" && !result[i]) {
          let kw = Math.floor((totalW * w.value) / denom);
          if (w.max !== undefined) kw = Math.min(kw, w.max); // 先上限
          if (w.min !== undefined) kw = Math.max(kw, w.min); // 再保底（min>max 时 min 赢）
          kw = Math.max(1, kw);
          if (kw > remaining) kw = Math.max(1, remaining); // 受可分配宽封顶
          result[i] = { w: kw, width: w };
          remaining -= kw;
        }
      }
    }
  }
  // 3. auto：以内容自然宽为宽，夹 max/min；min>max 时 min 赢
  for (let i = 0; i < children.length; i++) {
    const w = widths[i]!;
    if (w.mode !== "auto" || result[i]) continue;
    const nat = natural.get(children[i]!)!;
    let kw = nat.w;
    const mx = "max" in w ? w.max : undefined;
    const mn = "min" in w ? w.min : undefined;
    if (mx !== undefined) kw = Math.min(kw, mx); // 先上限
    if (mn !== undefined) kw = Math.max(kw, mn); // 再保底（min>max 时 min 赢）
    kw = Math.max(1, Math.min(kw, Math.max(1, remaining))); // 可分配封顶
    result[i] = { w: kw, width: w };
    remaining -= kw;
  }
  // 4. 无声明子项 ≡ auto：按内容自然宽（余量留白）——仅处理 width 为 undefined 者；
  //    显式 auto/fill 由第 3/5 段处理，此处不得吞掉 fill
  for (let i = 0; i < children.length; i++) {
    if (result[i] || children[i]!.width !== undefined) continue;
    const nat = natural.get(children[i]!)!;
    const kw = Math.max(1, Math.min(nat.w, Math.max(1, remaining)));
    result[i] = { w: kw, width: { mode: "auto" } };
    remaining -= kw;
  }
  // 5. fill：平分剩余；逐个应用 min/max，被 max 截断的空间回流给未封顶的 fill
  {
    const fillIdx: number[] = [];
    for (let i = 0; i < children.length; i++) {
      const w = widths[i]!;
      if (w.mode === "fill" && !result[i]) fillIdx.push(i);
    }
    if (fillIdx.length > 0) {
      // 初始平分（含余数从左到右）
      const init: number[] = [];
      let pool = Math.max(0, remaining);
      const share = Math.floor(pool / fillIdx.length);
      let carry = pool - share * fillIdx.length;
      for (let k = 0; k < fillIdx.length; k++) {
        let v = share + (carry > 0 ? 1 : 0);
        carry -= carry > 0 ? 1 : 0;
        init[k] = v;
      }
      // 应用 min/max 并回流：先给 min 抬升（若有），再 clamp max，
      // max 截断量累计共享，匀给尚未封顶（未达 max）的 fill
      const grants: number[] = init.slice();
      // 先处理 min 抬升（从 fill 池借，超池则不动——强制项优先）
      let poolAfter = remaining - grants.reduce((a, b) => a + b, 0);
      for (let k = 0; k < fillIdx.length; k++) {
        const wd = widths[fillIdx[k]!]!;
        const mn = "min" in wd ? wd.min : undefined;
        if (mn !== undefined && grants[k]! < mn) {
          const need = mn - grants[k]!;
          const take = Math.min(need, poolAfter);
          grants[k]! += take;
          poolAfter -= take;
        }
      }
      // max 截断 + 回流
      let freed = 0;
      for (let k = 0; k < fillIdx.length; k++) {
        const wd = widths[fillIdx[k]!]!;
        const mx = "max" in wd ? wd.max : undefined;
        if (mx !== undefined && grants[k]! > mx) {
          freed += grants[k]! - mx;
          grants[k]! = Math.max(0, mx);
        }
      }
      // 回流：给未封顶（无 max 或未达 max）的 fill 匀分
      for (let k = 0; k < fillIdx.length && freed > 0; k++) {
        const wd = widths[fillIdx[k]!]!;
        const mx = "max" in wd ? wd.max : undefined;
        const cap =
          mx !== undefined
            ? Math.min(
                mx,
                remaining - (grants.reduce((a, b) => a + b, 0) - grants[k]!),
              )
            : remaining;
        const room = Math.max(0, cap - grants[k]!);
        const give = Math.min(room, freed);
        grants[k]! += give;
        freed -= give;
        if (freed <= 0) break;
      }
      for (let k = 0; k < fillIdx.length; k++) {
        const i = fillIdx[k]!;
        result[i] = { w: Math.max(0, grants[k]!), width: widths[i]! };
        remaining -= grants[k]!;
      }
    }
  }
  // 6. 过度约束：remaining < 0（fixed/min/ratio/auto 已溢出）按让路顺序压缩
  if (remaining < 0) {
    const shrink = [...Array(children.length).keys()].sort((a, b) => {
      // 让路序：fill(5) → auto(4) → ratio(3) → fixed(1)；min/max 随载体
      const pa =
        widths[a]!.mode === "fill"
          ? 5
          : widths[a]!.mode === "auto"
            ? 4
            : widths[a]!.mode === "ratio"
              ? 3
              : 1;
      const pb =
        widths[b]!.mode === "fill"
          ? 5
          : widths[b]!.mode === "auto"
            ? 4
            : widths[b]!.mode === "ratio"
              ? 3
              : 1;
      return pb - pa;
    });
    for (const i of shrink) {
      if (remaining >= 0) break;
      const w = widths[i]!;
      const minFloor = w.mode === "fill" ? 0 : 1;
      if (result[i]!.w <= minFloor) continue;
      const cut = Math.min(result[i]!.w - minFloor, -remaining);
      result[i]!.w -= cut;
      remaining += cut;
    }
  }
  // 底线强于一切：非 fill 子项保 ≥1（fill 无剩余得 0 合法）
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
      // height:fill 是剩余吸收者：不主张测量高（allocate 时才分给剩余）
      h += box.children[i]!.height?.mode === "fill" ? 0 : m.h;
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
  // fill 平分剩余（无剩余得 0；余数从左到右：share=floor(pool/count)，carry 逐项 +1）
  const nonFillTotal = heights
    .filter((_, i) => prio[i] !== 5)
    .reduce((a, b) => a + b, 0);
  const fillPool = Math.max(0, avail - nonFillTotal);
  if (fillCount > 0) {
    const share = Math.floor(fillPool / fillCount);
    let carry = fillPool - share * fillCount;
    for (let i = 0; i < box.children.length; i++) {
      if (heights[i] !== -1) continue;
      const extra = carry > 0 ? 1 : 0;
      carry -= extra;
      heights[i] = share + extra;
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
