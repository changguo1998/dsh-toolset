// TUI/src/app/layout/measure.ts — Box 排版尺寸测量与矩形分配（规范见 SPEC.md §6）
//
// 接口冻结后的纯函数实现：measure 自底向上量尺寸（宽锁→高自由生长），
// allocate 自顶向下切矩形。不解析 markdown（fill 阶段的事），只按 displayWidth
// 折行/截断。复用既有 wrapLine/truncateToWidth/displayWidth 宽度原语。

import { wrapLine, truncateToWidth } from "./primitives.ts";
import { displayWidth } from "./markdown.ts";
import type {
  Node,
  Box,
  Paragraph,
  StyledText,
  Rect,
  Width,
  Height,
} from "./box.ts";

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

/** 首行/续行可用宽与缩进（prefix/suffix 先占列）；Paragraph 与 StyledText 共享 */
function paraWidthCtx(node: Paragraph | StyledText) {
  const prefixW = node.prefix ? displayWidth(node.prefix.text) : 0;
  const suffixW = node.suffix ? displayWidth(node.suffix.text) : 0;
  const indent = node.indent ?? 0;
  const hanging = node.hanging ?? indent;
  return { prefixW, suffixW, indent, hanging };
}

/** height.fixed 声明覆盖测量高（v 排布 spacer/固定行高区用） */
function applyDeclaredHeight(node: Node, m: MeasuredSize): MeasuredSize {
  if (node.height?.mode === "fixed") return { w: m.w, h: node.height.rows };
  return m;
}

/** 预样式中段的拼接文本（显示宽度测量用；样式忽略） */
function styledText(node: StyledText): string {
  return node.segments.map((s) => s.text).join("");
}

/** 测量单个预样式叶子：按拼接文本折行（StyledText） */
/** 按物理行（\n 切分）折行，产出显示行列表——StyledText/Paragraph 测量共用，
 * 与 fill 的 splitAndWrapSegments 语义一致（显式换行 = 行边界，非零宽字符）。 */
function paragraphRows(
  text: string,
  firstW: number,
  contW: number,
  wrap: boolean,
): string[] {
  const rows: string[] = [];
  const physical = text.split("\n");
  for (let pi = 0; pi < physical.length; pi++) {
    const line = physical[pi]!;
    if (line === "") {
      rows.push("");
      continue;
    }
    if (rows.length === 0) {
      // 首个物理行：首行用全宽，续行用 hanging 减宽（悬挂语义）
      rows.push(...wrapParagraph(line, Math.max(1, firstW), wrap));
    } else {
      rows.push(...wrapParagraph(line, Math.max(1, contW), wrap));
    }
  }
  if (rows.length === 0) rows.push("");
  return rows;
}

/** 测量单个预样式叶子：按拼接文本折行（StyledText） */
function measureStyledText(node: StyledText, maxW: number): MeasuredSize {
  const { prefixW, suffixW, indent, hanging } = paraWidthCtx(node);
  const firstW = maxW - indent - prefixW - suffixW; // 首行可用正文宽
  const contW = maxW - hanging - suffixW;
  const wrap = node.wrap !== false;
  const text = styledText(node);
  const rows = paragraphRows(text, firstW, contW, wrap);
  // 总宽 = max(首行 overhead+首行宽, 续行 overhead(hanging)+续行最宽) + suffix
  const firstTotal = indent + prefixW + displayWidth(rows[0]!);
  const contTotal =
    hanging + Math.max(...rows.slice(1).map((r) => displayWidth(r)), 0);
  return { w: Math.max(firstTotal, contTotal) + suffixW, h: rows.length };
}
function measureParagraph(node: Paragraph, maxW: number): MeasuredSize {
  const { prefixW, suffixW, indent, hanging } = paraWidthCtx(node);
  const firstW = maxW - indent - prefixW - suffixW; // 首行可用正文宽
  const contW = maxW - hanging - suffixW; // 续行可用正文宽（suffix 逐行重复占列）
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
  // 总宽 = max(首行 overhead+首行宽, 续行 overhead(hanging)+续行最宽) + suffix
  const firstTotal = indent + prefixW + displayWidth(rows[0]!);
  const contTotal =
    hanging + Math.max(...rows.slice(1).map((r) => displayWidth(r)), 0);
  return { w: Math.max(firstTotal, contTotal) + suffixW, h: rows.length };
}

/** 子项声明宽度（无声明 → auto） */
function widthOf(node: Node): Width {
  return node.width ?? { mode: "auto" };
}

/** 给 h 排布的子项按分配宽度（SPEC §6.5 冻结优先级）。
 *
 * 契约：先算每个子项的无约束目标与显式底线，再按优先级逐层满足；
 * 总目标超宽时分层压缩（fill→auto→ratio→破 min→fixed），压缩前不把
 * auto/ratio 封顶到“当前剩余”。
 */
function allocateWidths(
  children: Node[],
  totalW: number,
  natural: Map<Node, MeasuredSize>,
): { w: number; constrain: Width }[] {
  const widthOfNode = (n: Node): Width => n.width ?? { mode: "auto" };
  const wids = children.map(widthOfNode);
  // 无约束目标 target[i] 与显式底线 floor[i]
  const target: number[] = [];
  const floor: number[] = [];
  const mode: ("fixed" | "ratio" | "auto" | "fill")[] = [];
  for (let i = 0; i < children.length; i++) {
    const w = wids[i]!;
    if (w.mode === "fixed") {
      mode[i] = "fixed";
      const fw = Math.max(1, w.cols);
      target[i] = fw;
      floor[i] = fw; // fixed 底线 = 其值
      continue;
    }
    if (w.mode === "ratio") {
      mode[i] = "ratio";
      target[i] = 0; // 稍后按分数算
      floor[i] = w.min ?? 0;
      continue;
    }
    if (w.mode === "fill") {
      mode[i] = "fill";
      target[i] = 0; // 吃剩余，暂 0
      floor[i] = w.min ?? 0;
      continue;
    }
    // auto（含无声明）
    mode[i] = "auto";
    const nat = natural.get(children[i]!)!.w;
    let t = nat;
    const mx = "max" in w ? w.max : undefined;
    const mn = "min" in w ? w.min : undefined;
    if (mx !== undefined) t = Math.min(t, mx); // 先上限
    if (mn !== undefined) t = Math.max(t, mn); // 再保底（min>max 时 min 赢）
    target[i] = t;
    floor[i] = mn ?? 0;
  }
  // ratio 目标：value=容器分数（1/3=三分之一）基数容器总宽；仅 Σvalue>1 归一
  {
    let rs = 0;
    let rc = 0;
    for (let i = 0; i < children.length; i++) {
      if (mode[i] === "ratio") {
        rs += (wids[i]! as Extract<Width, { mode: "ratio" }>).value;
        rc++;
      }
    }
    if (rc > 0) {
      const denom = rs > 1 ? rs : 1;
      for (let i = 0; i < children.length; i++) {
        if (mode[i] !== "ratio") continue;
        const w = wids[i]! as Extract<Width, { mode: "ratio" }>;
        let t = Math.floor((totalW * w.value) / denom);
        if (w.max !== undefined) t = Math.min(t, w.max); // 先上限
        if (w.min !== undefined) t = Math.max(t, w.min); // 再保底（min>max 时 min 赢）
        t = Math.max(1, Math.max(t, floor[i]!));
        target[i] = t;
      }
    }
  }
  // 目标汇总后：取 target 快照为当前分配，fixed 底线已在 target 内
  const assign = target.slice();
  // 预汇总：fixed + ratio + auto 目标
  let consumed = 0;
  for (let i = 0; i < children.length; i++) {
    if (mode[i] !== "fill") consumed += target[i]!;
  }
  // fill 池 = 剩余（先按目标，暂不管 ratio/auto 是否超宽）
  const fillIdx: number[] = [];
  for (let i = 0; i < children.length; i++) {
    if (mode[i] === "fill") fillIdx.push(i);
  }
  let fillPool = totalW - consumed;
  // fill 迭代：平分池；某 fill 达 max 则封顶并把超出量回流给其余 fill，直至无回流源
  const fillVal: number[] = fillIdx.map(() => 0);
  const fillCapped: boolean[] = fillIdx.map(() => false);
  if (fillIdx.length > 0) {
    let active = fillIdx.length;
    while (active > 0 && fillPool > 1) {
      const share = Math.floor(fillPool / active);
      if (share <= 0) break;
      let carry = fillPool - share * active;
      let cappedThisRound = false;
      const before = fillPool;
      for (let k = 0; k < fillIdx.length; k++) {
        if (fillCapped[k]) continue;
        const w = wids[fillIdx[k]!]! as Extract<Width, { mode: "fill" }>;
        const mx = w.max;
        let got = fillVal[k]! + share + (carry > 0 ? 1 : 0);
        carry -= carry > 0 ? 1 : 0;
        if (mx !== undefined && got > mx) {
          fillPool += got - mx; // 超出回流
          got = mx;
          fillVal[k] = got; // 保留封顶值
          fillCapped[k] = true;
          active--;
          cappedThisRound = true;
        } else {
          fillVal[k] = got;
        }
      }
      // 本轮无人封顶且池没变化 → 全部分配稳定，退出
      if (!cappedThisRound && fillPool === before) break;
      // 池在平分中被耗尽且无人回流 → 退出
      if (fillPool <= 0) break;
    }
  }
  // 汇总 fill 最终值到 assign
  for (let k = 0; k < fillIdx.length; k++) {
    assign[fillIdx[k]!] = Math.max(0, fillVal[k]!);
    // fill 也要 min 保底（在预算内才抬；预算外由压缩阶段处理）
    const w = wids[fillIdx[k]!]! as Extract<Width, { mode: "fill" }>;
    if (w.min !== undefined && assign[fillIdx[k]!]! < w.min) {
      assign[fillIdx[k]!] = w.min;
    }
  }
  // 压缩阶段（advisor 冻结语义）：总值超 totalW 时按序收缩——
  // 第一遍 fill→auto→ratio 让到各自显式 min（不破），仍超则第二遍
  // 破 fill/auto/ratio 的 min（压到 0），fixed 最后才让（不可破到 0 以下）。
  let deficit = assign.reduce((a, b) => a + b, 0) - totalW;
  const shrinkLayer = (iList: number[], canBreakFloor: boolean): void => {
    // 同层先按分配值从大到小让
    iList.sort((a, b) => assign[b]! - assign[a]!);
    for (const i of iList) {
      if (deficit <= 0) return;
      const minFloor = canBreakFloor ? 0 : floor[i]!;
      const cut = Math.min(assign[i]! - minFloor, deficit);
      if (cut <= 0) continue;
      assign[i]! -= cut;
      deficit -= cut;
    }
  };
  const collect = (m: (typeof mode)[number]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (mode[i] === m) out.push(i);
    }
    return out;
  };
  const order: (typeof mode)[number][] = ["fill", "auto", "ratio"];
  if (deficit > 0) {
    for (const m of order) {
      if (deficit <= 0) break;
      shrinkLayer(collect(m), false); // 不破 min
    }
  }
  if (deficit > 0) {
    for (const m of order) {
      if (deficit <= 0) break;
      shrinkLayer(collect(m), true); // 破 min 压到 0
    }
  }
  if (deficit > 0) {
    // 最后才让 fixed（可让到其 floor=自身值，即不可让；再破时也仅到 0 兜底已在最后）
    for (let i = 0; i < children.length && deficit > 0; i++) {
      if (mode[i] !== "fixed") continue;
      const cut = Math.min(assign[i]! - 1, deficit);
      if (cut <= 0) continue;
      assign[i]! -= cut;
      deficit -= cut;
    }
  }
  // 兜底：非 fill 至少 1 列（底线强于一切）；fill 可为 0
  for (let i = 0; i < children.length; i++) {
    if (mode[i] !== "fill" && assign[i]! < 1) assign[i]! = 1;
  }
  return children.map((_, i) => ({
    w: Math.max(0, Math.floor(assign[i]!)),
    constrain: wids[i]!,
  }));
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
  if (node.kind === "styled") {
    const m = applyDeclaredHeight(node, measureStyledText(node, c.maxW));
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
  // fill 项的 min 预留：auto 折宽上界先扣除（右侧留白如用户块 gutter）
  let fillReserve = 0;
  for (let i = 0; i < box.children.length; i++) {
    const wd = widthOf(box.children[i]!);
    if (wd.mode === "fill" && wd.min !== undefined) fillReserve += wd.min;
  }
  // 第一遍：fixed/ratio/auto 先按自然宽测量（auto 以 max/扣 fill.min 为上界）
  for (let i = 0; i < box.children.length; i++) {
    const child = box.children[i]!;
    const wd = widthOf(child);
    const reserve = wd.mode === "fill" ? 0 : fillReserve;
    const upper =
      wd.mode === "auto" && wd.max !== undefined
        ? Math.min(c.maxW, wd.max)
        : Math.max(1, c.maxW - reserve);
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
  if (node.kind === "text" || node.kind === "styled") return;
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
