// TUI/src/app/layout/table.ts — markdown 表格：解析 + 构建期降级（规范见 SPEC.md §3.2）
//
// 表格列宽是跨行约束（同列各行必须等宽），纯 v/h 嵌套表达不了跨兄弟约束，
// 因此在内容映射层把 2D 数学算完：
//   量各格自然宽 → 水位法压缩（下限 minW）→ 产出
//   v([ h([┃, 空格, pad, cell, pad, │, …]), ┃ ══╪═…, 数据行… ])
// 的固定宽 Box 子树；布局引擎保持两类节点（Box/Paragraph），不新增 table 构造子。
// 网格：左缘一列回复竖线 `┃`（与 assistant 正文同列同色、整表逐行连续）+ 1 空格
// prefix（横线与其不连接，故左缘不设交叉字）、表头下双横线 `═`（列分隔交叉处 `╪`）、
// 数据行之间单横线 `─`（交叉处 `┼`，内容折行时用于区分行）。
//
// 单元格内容按行内 markdown 解析后作为 StyledText 叶子（若留作 Paragraph 原文，
// measure 会把 `**` 等标记算进宽度，行高与 fill 折行口径不一致）；行高由引擎自身
// measure 在分配列宽下算得后显式声明，供 valign:center 补白矮格。

import type { Box, Node, StyledText } from "./box.ts";
import { v, h, styled, spacer } from "./box.ts";
import type { FrameSegment, FrameStyle } from "../../renderer/screen.ts";
import {
  displayWidth,
  parseInlineMarkdown,
  wrapFrameSegments,
} from "./markdown.ts";
import { seg } from "./primitives.ts";

/** 列对齐：`:---` 左（缺省）/ `:--:` 中 / `---:` 右 */
export type TableAlign = "left" | "center" | "right";

/** 解析后的表格：表头、列对齐、数据行（单元格为行内 markdown 源码） */
export interface TableSpec {
  header: string[];
  aligns: TableAlign[];
  rows: string[][];
}

/** 单元格左右留白列数（表头/数据行一致，保证列分隔符逐行同列） */
const CELL_PAD = 1;

/** 左缘回复竖线列宽（1 列）：表格内容整体位于其右侧，整表竖线逐行连续 */
const BAR_COLS = 1;

/** 左缘回复竖线字形与配色（与 assistant 正文 `┃` 一致） */
const BAR_CHAR = "┃";
const BAR_STYLE: FrameStyle = { fg: "brightBlue" };

/** 回复竖线与表格内容之间的间隔列（表格 box 的 prefix 空格）：横线止于其右侧，
 *  不与回复竖线连接——连接会让竖线列被交叉字替换掉，整条回复竖线断开。 */
const BAR_GAP = 1;

/** 列分隔字形（前景色实线，末列不画） */
const COL_SEP = "│";

/** 表头下横线字形（双横线，区别于 turn 分隔的 ╌） */
const HEAD_RULE = "═";

/** 数据行之间的横线字形（内容折行时用于区分行） */
const ROW_RULE = "─";

/** 列分隔↔横线交叉字形（表格内侧，`╪` 双横 / `┼` 单横；左缘竖线与横线之间
 *  隔着 BAR_GAP 空格、并不相接，故左缘不设交叉字） */
const HEAD_CROSS = "╪";
const ROW_CROSS = "┼";

/** 每列最小宽下限：max(3, ⌈自然宽/4⌉)（SPEC §3.2 minW 策略） */
function minColWidth(natural: number): number {
  return Math.max(3, Math.ceil(natural / 4));
}

// ---------------- 解析 ----------------

/**
 * 行内 `|` 切分单元格：`\|` 为转义（不切，留待行内解析还原），行首/行尾的
 * 空单元格（外框 `|`）剥除。整行无未转义 `|` → 返回 null（非表格行）。
 */
export function splitCells(line: string): string[] | null {
  const cells: string[] = [];
  let cur = "";
  let sawPipe = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") {
      cur += ch;
      const nx = line[i + 1];
      if (nx !== undefined) {
        cur += nx;
        i += 1;
      }
      continue;
    }
    if (ch === "|") {
      sawPipe = true;
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (!sawPipe) return null;
  if (cells.length > 0 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** 含未转义 `|`（表格行候选的 O(1) 预筛，避免长回复全量扫描） */
export function hasCellPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "|") return true;
  }
  return false;
}

/** 分隔行单元格：`:?-+:?`（GFM，至少一个 `-`） */
function isDelimCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell);
}

/** 分隔行单元格 → 列对齐（`:--` 左 / `:-:` 中 / `--:` 右） */
function delimAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/** 分隔行是否显式标注对齐（显式时不启用数字列自动右对齐） */
function hasExplicitAlign(cell: string): boolean {
  return cell.startsWith(":") || cell.endsWith(":");
}

/** 数字单元格：可带符号 / 千分位 / 小数 / 百分号（数字列自动右对齐判据） */
function isNumericCell(cell: string): boolean {
  return /^[-+]?\d[\d,]*(\.\d+)?%?$/.test(cell.trim());
}

/**
 * 表头行 + 分隔行成对判定（分隔行每格形如 `:?-+:?`；列数**只允许少、不允许多**）。
 *
 * 列数口径（2026-10-23 起容错）：分隔行少于表头列数时仍判为表格——上游任何一处把分隔行
 * 写短（历史真机实例：4 列表头 + 2 列分隔行）都不该让整表退回原样打印；缺的列按左对齐
 * 补（见 `parseTableAt`）。分隔行**多于**表头列数仍拒绝（表头缺格，语义不明）。
 * 预筛用途：只有成对才继续收集数据行（O(1) 判定，长回复下不做全量扫描）。
 */
export function isTableStart(header: string, delimiter: string): boolean {
  const head = splitCells(header);
  const delim = splitCells(delimiter);
  if (!head || head.length === 0) return false;
  if (!delim || delim.length === 0) return false;
  if (delim.length > head.length) return false;
  return delim.every(isDelimCell);
}

/**
 * 自 lines[start] 起解析 markdown 表格：表头 + 分隔行 + 若干数据行（各行须含 `|`，
 * 否则表格结束）。数据行缺格补空、多格忽略（列数取表头）。非表格返回 null；
 * end = 首个未消费行下标（= 表格之后的行）。
 *
 * 列数取**表头**（分隔行可能短于表头，容错口径见 `isTableStart`）：缺对齐信息的列
 * 按左对齐，`aligns` 长度恒等于表头列数。
 */
export function parseTableAt(
  lines: readonly string[],
  start: number,
): { table: TableSpec; end: number } | null {
  const headerLine = lines[start];
  const delimLine = lines[start + 1];
  if (headerLine === undefined || delimLine === undefined) return null;
  if (headerLine.includes("\n") || delimLine.includes("\n")) return null;
  if (!isTableStart(headerLine, delimLine)) return null;
  const header = splitCells(headerLine)!;
  const delimCells = splitCells(delimLine)!;
  // 分隔行短于表头：缺的列按左对齐补（不把整表判为非表格）
  const aligns = header.map((_, j) =>
    delimCells[j] === undefined ? "left" : delimAlign(delimCells[j]!),
  );
  const rows: string[][] = [];
  let end = start + 2;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    if (line.includes("\n")) break;
    const cells = splitCells(line);
    if (!cells || cells.length === 0) break;
    rows.push(header.map((_, j) => cells[j] ?? ""));
  }
  // 数字列自动右对齐：分隔行未显式标注（无 `:`）且表体非空格全为数字 → 右对齐
  for (let j = 0; j < aligns.length; j++) {
    const delimCell = delimCells[j];
    if (delimCell !== undefined && hasExplicitAlign(delimCell)) continue;
    const body = rows.map((r) => (r[j] ?? "").trim()).filter((c) => c !== "");
    if (body.length > 0 && body.every(isNumericCell)) aligns[j] = "right";
  }
  return { table: { header, aligns, rows }, end };
}

// ---------------- 列宽 ----------------

/**
 * 目标宽（按 weight 比例）分配到可用宽 avail：先按比例取整并夹到 floor 下限，
 * 超出的从可让空间最大的列逐列削 1 至 floor；欠分配的回补到余量最大的列（上限 cap）。
 * 确定性（同输入同输出，固定遍历序），保证同类表格逐帧稳定。
 */
function fitTo(
  weight: number[],
  floor: number[],
  cap: number[],
  avail: number,
): number[] {
  const total = weight.reduce((a, b) => a + b, 0);
  const out = weight.map((w, j) =>
    Math.max(floor[j]!, Math.floor((w * avail) / total)),
  );
  let over = out.reduce((a, b) => a + b, 0) - avail;
  while (over > 0) {
    let pick = -1;
    for (let j = 0; j < out.length; j++) {
      if (out[j]! - floor[j]! <= 0) continue;
      if (pick < 0 || out[j]! - floor[j]! > out[pick]! - floor[pick]!) pick = j;
    }
    if (pick < 0) break; // 全部到底线：minW 也放不下（调用方转截断路径）
    out[pick]! -= 1;
    over -= 1;
  }
  let under = avail - out.reduce((a, b) => a + b, 0);
  while (under > 0) {
    let pick = -1;
    for (let j = 0; j < out.length; j++) {
      if (out[j]! >= cap[j]!) continue;
      if (pick < 0 || cap[j]! - out[j]! > cap[pick]! - out[pick]!) pick = j;
    }
    if (pick < 0) break;
    out[pick]! += 1;
    under -= 1;
  }
  return out;
}

/**
 * 水位线：最大的 level 使 Σ min(自然宽, level) ≤ avail（二分）。
 * 压缩时以它为各列共同上限——窄列保持自然宽、只有超宽列被压，
 * 避免「按自然宽比例缩放」把窄列压到 minW 以下（表头换行的难看来源）。
 */
function waterLevel(natural: number[], avail: number): number {
  const fits = (level: number): boolean =>
    natural.reduce((a, n) => a + Math.min(n, level), 0) <= avail;
  let lo = 0;
  let hi = Math.max(...natural);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 列宽求解：自然宽放得下 → 原样；否则压缩（水位线 + 下限 minW）；
 * 连 minW 也放不下 → **放弃表格**（返回 null，调用方退回普通文本行渲染）。
 * #6：不再做「minW 比例分配 + 格内省略号截断」——内容一律不截断（用户 2026-10-01 裁定）。
 */
export function fitCols(natural: number[], avail: number): number[] | null {
  const sum = natural.reduce((a, b) => a + b, 0);
  if (sum <= avail) return natural;
  const min = natural.map(minColWidth);
  const minSum = min.reduce((a, b) => a + b, 0);
  if (minSum > avail) return null; // 容不下最小列宽：退回普通文本行（内容完整、无表格线）
  const level = waterLevel(natural, avail);
  // 各列以水位线为上限，并尽量不低于 minW（窄列保持自然宽，只有超宽列被压）
  const fair = natural.map((n, j) => Math.min(n, Math.max(min[j]!, level)));
  const fairSum = fair.reduce((a, b) => a + b, 0);
  // 抬到 minW 后超预算（ΣminW 本身仍放得下）→ 以纯水位线为准（不牺牲窄列）
  const base = fairSum <= avail ? fair : natural.map((n) => Math.min(n, level));
  return fitTo(base, base, natural, avail);
}

// ---------------- 构建 ----------------

/** 单元格解析后的纯文本（自然宽测量口径：与 fill 渲染文本一致，不计标记） */
function cellPlainText(cell: string): string {
  return parseInlineMarkdown(cell)
    .map((s) => s.text)
    .join("");
}

/** 单元格叶子：行内 markdown 解析 + 固定列宽 + 列对齐（表头加粗；#6 起**不做格内截断**） */
function cellLeaf(
  cell: string,
  colW: number,
  align: TableAlign,
  header: boolean,
): StyledText {
  let segs: FrameSegment[] = parseInlineMarkdown(cell);
  if (header)
    segs = segs.map((s) => ({
      text: s.text,
      style: { ...(s.style ?? {}), bold: true },
    }));
  return styled(segs, {
    widthStyle: "fixed",
    widthFixed: colW,
    align,
    valign: "center",
  });
}

/**
 * 单元格叶子在自身固定列宽下的行数（**与渲染同源**）。
 *
 * 不能按 `ceil(显示宽 / 列宽)` 估算：`wrapFrameSegments` 在「下一个字符放不进剩余列」时
 * 提前换行（宽字符 2 列落进最后 1 列时该行只填一半），估算值会**低估**行数 → `rowBox`
 * 把偏小值写死成 `heightFixed` → 折行多出的行溢出到行 box 之外，该行左缘 `┃` 与列分隔
 * `│` 全丢（A3 复现之一，2026-10-23）。故直接调用渲染用的同一个折行函数取行数。
 */
function measureLeafRows(leaf: StyledText): number {
  const width = Math.max(1, leaf.width ?? 1);
  const suffixW = leaf.suffix ? displayWidth(leaf.suffix.text) : 0;
  const bodyW = Math.max(1, width - suffixW);
  // 单元格正常不含显式换行；含时按物理行分别折行再累加（与 fill 的 Paragraph 口径一致）
  return leaf.segments
    .map((s) => s.text)
    .join("")
    .split("\n")
    .reduce(
      (rows, line) =>
        rows +
        Math.max(1, wrapFrameSegments(parseInlineMarkdown(line), bodyW).length),
      0,
    );
}

/** 竖线字形叶子：按行数铺出同样多行（行高显式声明）——行 box 高 = 行高，
 *  单行叶子在续行会被 fill 当作"无内容"补白，故左竖线与列分隔须逐行重复。
 *  无 style 时用主题默认前景色（网格线一律不着色）。 */
function vLineLeaf(ch: string, rows: number, style?: FrameStyle): StyledText {
  return styled([seg(Array(rows).fill(ch).join("\n"), style)], {
    heightStyle: "fixed",
    heightFixed: rows,
  });
}

/** 横向填充叶子：整段横线（表头下 `═` / 数据行间 `─`，默认前景色），宽 = 列宽 + 左右留白 */
function hRuleLeaf(ch: string, w: number): StyledText {
  return styled([seg(ch.repeat(Math.max(1, w)))]);
}

/**
 * 组装一行网格：`回复竖线 | 间隔 | 留白 内容 留白 | 列分隔 | …`（末列后不画列分隔）。
 * 左缘保留回复竖线 `┃`（整条回复竖线连续），其后 BAR_GAP 空格：横线不与竖线连接，
 * 故左缘不设交叉字。cells 为该行各列内容（数据/表头行是单元格叶子）；sep 为列间
 * 字形（数据行 `│`）。
 */
function gridRow(
  bar: StyledText,
  cells: Node[],
  sep: string,
  sepRows: number,
): Box {
  const pad = (): Node => spacer({ widthStyle: "fixed", widthFixed: CELL_PAD });
  const kids: Node[] = [
    bar,
    spacer({ widthStyle: "fixed", widthFixed: BAR_GAP }),
  ];
  for (let j = 0; j < cells.length; j++) {
    kids.push(pad(), cells[j]!, pad());
    if (j < cells.length - 1) kids.push(vLineLeaf(sep, sepRows));
  }
  return h(kids);
}

/** 表格构建选项：左缘竖线配色（正文蓝 `brightBlue` / 思考紫 `brightMagenta`） */
export interface TableBoxOptions {
  /** 左缘竖线样式，缺省正文蓝 */
  barStyle?: FrameStyle;
}

/** 数据/表头行：左缘回复竖线 + 各格（固定列宽、列对齐）+ 列分隔 */
function rowBox(
  cells: string[],
  cols: number[],
  aligns: TableAlign[],
  header: boolean,
  barStyle: FrameStyle,
): Box {
  const leaves = cells.map((c, j) =>
    cellLeaf(c, cols[j]!, aligns[j] ?? "left", header),
  );
  // 行高 = 各格在本格列宽下的自身行数最大值（与折行同源的单叶测量算得）
  let rowH = 1;
  for (const leaf of leaves) {
    leaf.width = Math.max(1, leaf.widthFixed ?? 1);
    rowH = Math.max(rowH, measureLeafRows(leaf));
  }
  // 显式声明行高：fill 的 valign:center 补白依赖显式高度（SPEC §2 valign）
  for (const leaf of leaves) {
    leaf.heightStyle = "fixed";
    leaf.heightFixed = rowH;
  }
  return gridRow(vLineLeaf(BAR_CHAR, rowH, barStyle), leaves, COL_SEP, rowH);
}

/** 横线行（表头下双横线 / 数据行间单横线）：左缘回复竖线照常连续（不设交叉字），
 *  隔 BAR_GAP 空格后横线铺满整个列区域（含左右留白），与列分隔的交叉处以交叉字
 *  连接（保证交叉位置不断开）。 */
function ruleRow(
  cols: number[],
  ch: string,
  colCross: string,
  barStyle: FrameStyle,
): Box {
  const kids: Node[] = [
    vLineLeaf(BAR_CHAR, 1, barStyle),
    spacer({ widthStyle: "fixed", widthFixed: BAR_GAP }),
  ];
  for (let j = 0; j < cols.length; j++) {
    kids.push(hRuleLeaf(ch, cols[j]! + CELL_PAD * 2));
    if (j < cols.length - 1) kids.push(vLineLeaf(colCross, 1));
  }
  return h(kids);
}

/**
 * 表格 Box 子树：v([表头行, ═ 横线, 数据行…])，数据行之间以 `─` 分隔
 * （内容折行时用于区分「哪一行」）。整表左缘保留回复竖线 `┃`（与 assistant
 * 正文同列同色、逐行连续；思考行表格用思考紫，见 `TableBoxOptions`），竖线后隔
 * BAR_GAP 空格再排表格内容——横线不与回复竖线连接。可用宽 width 含左缘竖线 +
 * 间隔 + 列间分隔 + 每列左右留白；过窄返回 null，由调用方退回普通文本行渲染
 * （窄终端降级）。
 */
export function tableBox(
  table: TableSpec,
  width: number,
  opts: TableBoxOptions = {},
): Box | null {
  const barStyle = opts.barStyle ?? BAR_STYLE;
  const ncols = table.header.length;
  if (ncols === 0) return null;
  // 固定开销：左缘竖线 + 间隔 + 每列左右留白 + 列间分隔
  const overhead = BAR_COLS + BAR_GAP + CELL_PAD * 2 * ncols + (ncols - 1);
  if (width < overhead + ncols) return null;
  // 各列自然宽 = 该列所有格（渲染文本）最大显示宽
  const natural = table.header.map((head, j) => {
    let w = displayWidth(cellPlainText(head));
    for (const row of table.rows)
      w = Math.max(w, displayWidth(cellPlainText(row[j] ?? "")));
    return w;
  });
  const cols = fitCols(natural, width - overhead);
  if (cols === null) return null; // #6：容不下最小列宽 → 退回普通文本行（不截断内容）
  const body: Node[] = [
    rowBox(table.header, cols, table.aligns, true, barStyle),
    ruleRow(cols, HEAD_RULE, HEAD_CROSS, barStyle),
  ];
  for (let i = 0; i < table.rows.length; i++) {
    if (i > 0) body.push(ruleRow(cols, ROW_RULE, ROW_CROSS, barStyle));
    body.push(rowBox(table.rows[i]!, cols, table.aligns, false, barStyle));
  }
  return v(body);
}
