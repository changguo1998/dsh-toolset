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

// ---------------- 第 4 步下半：pane 项 → 行（折行 + 装饰） ----------------
//
// 口径：**凡是要用宽度才能定的，都在这一步加**。行生成复用既有排版算法库
// （`build-box.ts` 的 `buildContentRows` + `measure` / `allocate` / `fill` +
// `markdown.ts` 折行 + `table.ts` 表格 + `primitives.ts` 截断），本层只负责
// 「pane 项 → 旧口径的缓冲行」的映射与逐项行数记账，使结构 / 缓存 / 位置模型
// 都在新流水线里，而字形与装饰与旧路径逐行一致（等价性由 `pipeline-equivalence`
// 用例把关）。

import type { ActivityLevel, BufferLine } from "../../state.ts";
import { TURN_SEPARATOR } from "../../state.ts";
import { buildContentRows, type BuildBoxOptions } from "../build-box.ts";
import { stepHeaderLine, toolCallLine, toolResultLine } from "../tool-line.ts";
import { summarizeToolArguments } from "../../adapter/normalize.ts";
import type { ContentRow } from "../fill.ts";
import type { Box } from "./boxes.ts";
import type { PaneItem } from "./panes.ts";

export interface RenderOptions extends BuildBoxOptions {
  /** 会话区可用宽 */
  width: number;
  /** 回合区可用宽（缺省 = width） */
  activityWidth?: number;
  /** 活动区档位（透传给旧口径的 buildContentRows，保证逐行一致） */
  activityLevel?: ActivityLevel;
}

export interface RenderedPane {
  rows: ContentRow[];
  /** 每项贡献的行数（与 `items` 一一对应）——行数表的段 */
  readonly counts: readonly number[];
  readonly table: LineTable;
}

/**
 * 逻辑行 box → 旧口径缓冲行（原始形态，交给既有排版算法库）。
 * `dialogue` = 该 box 归会话区：旧口径按 `final` 分流（`assistant` 正文 final → 会话区），
 * 故会话区的正文行必须带 `final`，否则旧渲染器会把它排进回合区。
 */
export function boxToLines(box: Box, dialogue = false): BufferLine[] {
  const base = { seq: undefined } as const;
  void base;
  const scope = { step: box.step };
  if (box.shape === "tool") {
    const lines: BufferLine[] = [];
    for (const call of box.batch?.calls ?? []) {
      lines.push({
        text: toolCallLine(call.name, summarizeToolArguments(call.args)),
        kind: "tool",
        ...scope,
      });
    }
    for (const result of box.batch?.results ?? []) {
      lines.push({
        text: toolResultLine(result.ok, result.detail),
        kind: "tool",
        ...(!result.ok ? { tone: "error" as const } : {}),
        ...scope,
      });
    }
    return lines;
  }
  // 会话区归属：旧渲染器按 `final` 把 assistant 内容分流到会话区——代码块 / 表格同样要带
  const final = dialogue && box.source === "assistant";
  if (box.shape === "code") {
    const code = box.code ?? { lang: "", lines: [], closed: true };
    const kind = kindOf(box);
    return [
      { text: "```" + code.lang, kind, ...(final ? { final: true } : {}) },
      ...code.lines.map((line) => ({
        text: line,
        kind,
        ...(final ? { final: true } : {}),
      })),
      ...(code.closed
        ? [{ text: "```", kind, ...(final ? { final: true } : {}) }]
        : []),
    ];
  }
  if (box.shape === "table") {
    const table = box.table;
    if (table === undefined) return [];
    const row = (cells: readonly string[]): string =>
      "| " + cells.join(" | ") + " |";
    const aligns = table.aligns.map((align) =>
      align === "right" ? "---:" : align === "center" ? ":---:" : "---",
    );
    return [
      {
        text: row(table.header),
        kind: kindOf(box),
        ...(final ? { final: true } : {}),
      },
      {
        text: row(aligns),
        kind: kindOf(box),
        ...(final ? { final: true } : {}),
      },
      ...table.rows.map((cells) => ({
        text: row(cells),
        kind: kindOf(box),
        ...(final ? { final: true } : {}),
      })),
    ];
  }
  return [
    {
      text: box.text ?? "",
      kind: kindOf(box),
      ...(box.tone === undefined ? {} : { tone: box.tone }),
      ...(final ? { final: true } : {}),
      ...scope,
      // 用户行带行号：布局层用户块符号解析按 seq 回查 buffer 同源行
      ...(box.source === "user" && box.seqs?.[0] !== undefined
        ? { seq: box.seqs[0] }
        : {}),
    },
  ];
}

/** 来源 → 状态层的行类型（与旧路径同一分类口径） */
function kindOf(box: Box): BufferLine["kind"] {
  switch (box.source) {
    case "reasoning":
      return "thinking";
    case "tool":
      return "tool";
    case "notice":
      return "notice";
    case "shell":
      return "shell";
    case "user":
      return "user";
    default:
      return box.shape === "code" || box.shape === "table"
        ? "assistant"
        : "assistant";
  }
}

/** pane 项 → 旧口径缓冲行（边界项按既有线型：step 头 / 回合分隔线 / 空行） */
function itemLines(item: PaneItem, dialogue: boolean): BufferLine[] {
  switch (item.kind) {
    case "line":
      return boxToLines(item.box, dialogue);
    case "blank":
      return [{ text: "", kind: "plain" }];
    case "step-head":
      // 旧口径：step 头由 `appendToolLine` 插入（kind = tool），渲染为 `╌╌ hh:mm:ss #N ╌╌`
      return [
        {
          text: stepHeaderLine(item.step, item.time),
          kind: "tool",
        },
      ];
    case "turn-separator":
      return [
        {
          text: TURN_SEPARATOR,
          kind: "separator",
          ...(item.time === undefined ? {} : { time: item.time }),
          turn: item.turn,
        },
      ];
  }
}

// ---------------- 行缓冲缓存（键见追踪文档「行缓冲键的组成」） ----------------

/** 每个 box 的行结果：键 = 区域宽 + 档位 + 紧凑（宽度不变的重复帧直接命中） */
const rowCache = new WeakMap<Box, Map<string, ContentRow[]>>();
let misses = 0;

/** 缓存未命中次数（计数断言用：宽度不变时同段不重复排版） */
export function rowRenderMisses(): number {
  return misses;
}

export function resetRowRenderStats(): void {
  misses = 0;
}

function cacheKey(
  width: number,
  pane: "dialogue" | "activity",
  options: RenderOptions,
): string {
  return [
    pane,
    width,
    options.activityLevel ?? "think",
    options.activityCompact === true ? "compact" : "full",
  ].join("|");
}

/**
 * 逐项出一行缓冲 + 行数表（宽度相关）。每一项独立走既有算法库：跨项的分隔与留白
 * 已由第 3 步的边界项表达，故此处不再做跨节点后处理。
 * 文本项按 (box 身份, 宽, 档位, 紧凑) 命中行缓存——宽度不变的重复帧不重排。
 */
export function renderPane(
  items: readonly PaneItem[],
  pane: "dialogue" | "activity",
  options: RenderOptions,
): RenderedPane {
  const width = Math.max(1, options.width);
  const activityWidth = Math.max(1, options.activityWidth ?? width);
  const rows: ContentRow[] = [];
  const counts: number[] = [];
  for (const item of items) {
    const lines = itemLines(item, pane === "dialogue");
    if (lines.length === 0) {
      counts.push(0);
      continue;
    }
    // 用户块不走行缓存：其首行符号随回合状态变化（运行 ●/○ → 终态 ✓/✗/■，
    // 经 seq 回查 buffer 解析），缓存会渲染出上一状态的旧符号
    const cacheable =
      item.kind === "line" && item.box.source !== "user" ? item.box : undefined;
    const key = cacheKey(
      pane === "dialogue" ? width : activityWidth,
      pane,
      options,
    );
    let slot = cacheable === undefined ? undefined : rowCache.get(cacheable);
    const hit = slot?.get(key);
    if (hit !== undefined) {
      rows.push(...hit);
      counts.push(hit.length);
      continue;
    }
    // 只计内容项的排版次数：边界项（空行 / step 头 / 分隔线）是常量开销，不进计数
    if (cacheable !== undefined) misses += 1;
    const built = buildContentRows(
      lines,
      { ...options, width, activityWidth },
      width,
      activityWidth,
    );
    const produced = pane === "dialogue" ? built.dialogue : built.activity;
    if (cacheable !== undefined) {
      slot ??= new Map<string, ContentRow[]>();
      slot.set(key, produced);
      rowCache.set(cacheable, slot);
    }
    rows.push(...produced);
    counts.push(produced.length);
  }
  return { rows, counts, table: createLineTable(counts) };
}
