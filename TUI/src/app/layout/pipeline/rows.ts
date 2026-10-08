// src/app/layout/pipeline/rows.ts — 第 4 步的**行数表与位置模型**（宽度相关）
//
// 口径（追踪文档「行数表」「滚动位置模型（不加 follow）」）：
//   - 每段一行数 + 前缀和：查总行数、「第 N 行在哪段」都是 O(log n)，不必重排；
//   - 更新：段内容变 → 只更新受影响的段；宽度变 → 全量重算；
//   - 位置 = 偏移（距结尾的行数，0 = 贴底）+ 显示索引（`topIdx = 总行数 − 可见行数 − 偏移`）；
//     偏移 = 0 → 新增行后重算显示索引；偏移 ≠ 0 → 显示索引不动（画面内容不动）。
//
// 本文件只放纯算法（段行数 → 前缀和 → 索引换算）；box → 行的折行与装饰在第 4 步的
// 排版实现里，键含宽度（见追踪文档「行缓冲键的组成」）。

/**
 * 行数表：段 = 行缓冲里可独立失效的最小单位（一个 pane 项 / 一个节贡献的行段）。
 * 每段一行数 + 前缀和；`version` 供上层做等价断言与缓存键。
 */
export interface LineTable {
  /** 各段行数（顺序 = 段顺序） */
  readonly counts: readonly number[];
  /** 前缀和：`prefix[i]` = 前 i 段的总行数（长度 = counts.length + 1） */
  readonly prefix: readonly number[];
}

export function createLineTable(counts: readonly number[]): LineTable {
  const prefix: number[] = [0];
  let total = 0;
  for (const count of counts) {
    total += Math.max(0, count);
    prefix.push(total);
  }
  return { counts: [...counts], prefix };
}

/** 总行数 */
export function totalLines(table: LineTable): number {
  return table.prefix[table.prefix.length - 1] ?? 0;
}

/** 第 `index` 行落在哪一段（二分；越界返回 -1 / 段数） */
export function segmentAt(table: LineTable, index: number): number {
  const total = totalLines(table);
  if (index < 0 || index >= total) return index < 0 ? -1 : table.counts.length;
  let low = 0;
  let high = table.counts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((table.prefix[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** 段内偏移（该行是段内第几行，0 基）；越界返回 -1 */
export function rowInSegment(table: LineTable, index: number): number {
  const segment = segmentAt(table, index);
  if (segment < 0 || segment >= table.counts.length) return -1;
  return index - (table.prefix[segment] ?? 0);
}

/** 增量更新单段行数（段内容变 → 只改这一段；前缀和就地重算，段数少时足够廉价） */
export function withSegmentCount(
  table: LineTable,
  segment: number,
  count: number,
): LineTable {
  if (segment < 0 || segment >= table.counts.length) return table;
  const counts = [...table.counts];
  counts[segment] = Math.max(0, count);
  return createLineTable(counts);
}

/** 追加段（冻结集 append-only：只追加，不动既有前缀和的值） */
export function appendSegment(table: LineTable, count: number): LineTable {
  return createLineTable([...table.counts, count]);
}

/** 显示索引：总行数 − 可见行数 − 偏移（clamp 到 [0, max(0, 总行数 − 可见行数)]） */
export function topIndex(
  table: LineTable,
  visibleRows: number,
  offset: number,
): number {
  const total = totalLines(table);
  const max = Math.max(0, total - Math.max(0, visibleRows));
  return Math.min(Math.max(0, total - Math.max(0, visibleRows) - offset), max);
}

/** 由显示索引反算偏移（与 `topIndex` 互逆；索引 clamp 到可视范围） */
export function offsetOf(
  table: LineTable,
  visibleRows: number,
  index: number,
): number {
  const total = totalLines(table);
  const max = Math.max(0, total - Math.max(0, visibleRows));
  return Math.max(
    0,
    total - Math.max(0, visibleRows) - Math.min(Math.max(0, index), max),
  );
}

/** 位置：偏移 + 显示索引（`offset = 0` = 贴底） */
export interface Position {
  readonly offset: number;
  readonly index: number;
}

/** 贴底位置 */
export function atBottom(table: LineTable, visibleRows: number): Position {
  return { offset: 0, index: topIndex(table, visibleRows, 0) };
}

/**
 * 内容变化后的位置（两条规则，见追踪文档）：
 *   - 偏移 = 0（贴底）→ 重算显示索引（新增行后仍贴底）；
 *   - 偏移 ≠ 0 → 显示索引不动（画面内容不动；偏移随总行数一起变大）。
 * 两种情形走全量重算（**上方插入行** = 扩窗 / 上方段变高；**宽度变化** = 行号全变）：
 * 调用方按「段 + 段内偏移」换算一次新索引，换算不出则退回贴底（`remap`）。
 */
export function afterContentChange(
  table: LineTable,
  visibleRows: number,
  previous: Position,
): Position {
  if (previous.offset === 0) return atBottom(table, visibleRows);
  const total = totalLines(table);
  const maxIndex = Math.max(0, total - Math.max(0, visibleRows));
  const index = Math.min(previous.index, maxIndex);
  return { offset: offsetOf(table, visibleRows, index), index };
}

/**
 * 上方插入行 / 宽度变化后的重算：按「段 + 段内偏移」换算新索引。
 * @param locate 旧索引 → 该行所属段与段内偏移（换算不出返回 undefined → 退回贴底）
 * @param resolve 段 + 段内偏移 → 新索引（新表里的同一内容行）
 */
export function remap(
  table: LineTable,
  visibleRows: number,
  previous: Position,
  locate: (index: number) => { segment: number; row: number } | undefined,
  resolve: (segment: number, row: number) => number | undefined,
): Position {
  const anchor = locate(previous.index);
  if (anchor === undefined) return atBottom(table, visibleRows);
  const index = resolve(anchor.segment, anchor.row);
  if (index === undefined) return atBottom(table, visibleRows);
  const total = totalLines(table);
  const bounded = Math.min(
    Math.max(0, index),
    Math.max(0, total - Math.max(0, visibleRows)),
  );
  return { offset: offsetOf(table, visibleRows, bounded), index: bounded };
}
