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

// ---------------- 视口顶：段键 + 段内行 ↔ 绝对行号 ----------------
//
// 滚动位置**不存绝对行号**（宽度变化与上方插入行都会让它失效），而存「段键 + 段内行」：
//   - 上方插入段（扩窗纳入更早回合）→ 段键不变 → 同一内容留在原处，画面不动；
//   - 宽度变化 → 段内行数变，按段键定位到同一段；段内行超界时夹到该段末行；
//   - 段整个消失（该节被裁掉）→ 回落「距底偏移」（内容靠底则位置也靠底）。
/** 折叠占位行（「更早回复已折叠」）的段键 */
export const MARKER_KEY = "@marker";

/** 视口顶位置：段键 + 段内行（`null` = 贴底跟随最新） */
export interface DialogueTop {
  readonly key: string;
  readonly row: number;
}

/** 绝对行号 → 视口顶位置（越界收敛到首 / 末段） */
export function positionAt(
  table: LineTable,
  keys: readonly string[],
  index: number,
): DialogueTop {
  const total = totalLines(table);
  if (total === 0 || keys.length === 0) return { key: "", row: 0 };
  const idx = Math.min(Math.max(0, index), total - 1);
  const segment = Math.max(0, Math.min(segmentAt(table, idx), keys.length - 1));
  return {
    key: keys[segment] ?? "",
    row: idx - (table.prefix[segment] ?? 0),
  };
}

/**
 * 视口顶位置 → 绝对行号（clamp 到 `[0, maxTop]`）：
 *   - `null` → `maxTop`（贴底）；
 *   - 段键不在表里 → 回落 `maxTop − fallbackOffset`（距底偏移）。
 */
export function indexOfTop(
  table: LineTable,
  keys: readonly string[],
  top: DialogueTop | null,
  fallbackOffset: number,
  maxTop: number,
): number {
  if (top === null) return maxTop;
  const segment = keys.indexOf(top.key);
  if (segment < 0)
    return Math.max(0, Math.min(maxTop, maxTop - Math.max(0, fallbackOffset)));
  const count = table.counts[segment] ?? 0;
  const row = Math.min(Math.max(0, top.row), Math.max(0, count - 1));
  const index = (table.prefix[segment] ?? 0) + row;
  return Math.max(0, Math.min(index, maxTop));
}

// ---------------- 第 4 步下半：pane 项 → 行（折行 + 装饰） ----------------
//
// 口径：**凡是要用宽度才能定的，都在这一步加**。行生成复用既有排版算法库
// （`build-box.ts` 的 `buildContentRows` + `measure` / `allocate` / `fill` +
// `markdown.ts` 折行 + `table.ts` 表格 + `primitives.ts` 截断），本层只负责
// 「pane 项 → 旧口径的缓冲行」的映射与逐项行数记账，使结构 / 缓存 / 位置模型
// 都在新流水线里，而字形与装饰与旧路径逐行一致（等价性由 `pipeline-equivalence`
// 用例把关）。

import type { ActivitySwitches, HistoryRow } from "../../state.ts";
import { TURN_SEPARATOR } from "../../state.ts";
import { buildContentRows, type BuildBoxOptions } from "../build-box.ts";
import { stepHeaderLine, toolDiffSummary } from "../tool-line.ts";
import type { ToolResult } from "./types.ts";
import type { ContentRow } from "../fill.ts";
import { toolUnits, type Box, type LayoutBox } from "./boxes.ts";
import type { PaneItem } from "./panes.ts";
// ---- 新链路（§3-§7）接线桥 ----
import type {
  PaneItem as NewPaneItem,
  UserRowInfo,
  Row as NewRow,
} from "./ir.ts";
import type { StructureOptions } from "./structure.ts";
import { buildTrees } from "./structure.ts";
import { measure } from "./measure.ts";
import { flattenAttributed } from "./flatten.ts";

export interface RenderOptions extends BuildBoxOptions {
  /** 会话区可用宽 */
  width: number;
  /** 回合区可用宽（缺省 = width） */
  activityWidth?: number;
  /** 活动区显示开关（透传给旧口径的 buildContentRows，保证逐行一致） */
  activityShow?: Partial<ActivitySwitches>;
}

/** 新链路（§3-§7）pane 排版输入（接线桥 renderPane 用；宽无关项在 structure 期消费） */
export interface PaneRenderOptions {
  /** 内容区可用宽 */
  width: number;
  /** 装饰可见度基准（prefix/suffix minWidth 判定；缺省 = width） */
  vw?: number;
  /** 用户/助手右缘留白（gutter） */
  gutter?: number;
  /** P1 用户块首行符号解析（info 缺省 = 无状态不显符号） */
  userSym?: (info?: UserRowInfo) => { text: string; fg?: string } | undefined;
  /** symbol-normalizer 服务（缺省原文透传） */
  normalize?: (text: string) => string;
  /** 活动区紧凑档位（/collapse；只对 activity pane 应用） */
  activityCompact?: Partial<ActivitySwitches>;
}

export interface RenderedPane {
  rows: ContentRow[];
  /** 每项贡献的行数（与 `items` 一一对应）——行数表的段 */
  readonly counts: readonly number[];
  /** 每项的稳定段键（与 `counts` 一一对应）：滚动位置按「段键 + 段内行」表达 */
  readonly keys: readonly string[];
  /** 用户块首行的绝对行号（PgUp / PgDn 跳转目标） */
  readonly userRows: readonly number[];
  readonly table: LineTable;
}

/** 结果行文本：详情（去尾空白）+ `(+N/-M)` 摘要（挂**首行**末尾；详情为空时只出摘要） */
function toolResultText(result: ToolResult): string {
  const detail = result.detail.replace(/\s+$/, "");
  const diff = toolDiffSummary(result.meta);
  if (diff === undefined) return detail;
  const at = detail.indexOf("\n");
  if (at < 0) return detail === "" ? diff : detail + " " + diff;
  return detail.slice(0, at) + " " + diff + detail.slice(at);
}

/**
 * 逻辑行 box → 旧口径缓冲行（原始形态，交给既有排版算法库）。
 * `dialogue` = 该 box 归会话区：旧口径按 `final` 分流（`assistant` 正文 final → 会话区），
 * 故会话区的正文行必须带 `final`，否则旧渲染器会把它排进回合区。
 */
export function boxToLines(
  box: Box,
  dialogue = false,
  active = false,
): HistoryRow[] {
  const scope = { step: box.step };
  if (box.kind === "layout") {
    // 表格容器 → 旧口径的原始表格行（表头 / 对齐分隔 / 数据行），表格渲染器重排；
    // 其余容器（类型块）不直接产出行。会话区的表格行带 final（旧口径同源）
    if (box.role === "table") return tableLines(box, dialogue);
    return [];
  }
  if (box.shape === "tool") {
    // 会话区只保留「历史行」（带 final）：恢复出来的工具批（`history` 盒）在会话区按
    // 历史行上屏；实时路径的工具行不带 final → 照旧只在回合区
    const hist = dialogue && box.history === true;
    const lines: HistoryRow[] = [];
    for (const unit of toolUnits(box.batch)) {
      if (unit.role === "name") {
        const result = unit.result;
        // 名字行：只有工具名（标记由渲染层按 `toolOk` 定：✓ / ✗ / 在飞 ●）
        lines.push({
          text: unit.call.name,
          kind: "tool",
          toolRole: "name",
          ...(result === undefined ? {} : { toolOk: result.ok }),
          ...(hist ? { final: true } : {}),
          ...scope,
        });
        continue;
      }
      if (unit.role === "param") {
        // 参数行：每个参数一行（名灰 + 值原色；折行 / 悬挂 6 列 / 5 行上限在渲染层）
        lines.push({
          text: unit.param.value,
          kind: "tool",
          toolRole: "param",
          toolParam: unit.param,
          ...(hist ? { final: true } : {}),
          ...scope,
        });
        continue;
      }
      // 结果行：只有详情（标记在名字行），**保留原始换行结构**（决策 8 第 7/8 条：按行拆、
      // 不做 markdown 解析）；折行 / 5 行上限 / 失败整行红都在渲染层。
      // 落单结果（无对应调用）没有名字行可挂标记 → 行内自带 `✓` / `✗`（决策 10 落单分支）
      const result = unit.result;
      const marker = unit.orphan === true ? (result.ok ? "✓ " : "✗ ") : "";
      lines.push({
        text: marker + toolResultText(result),
        kind: "tool",
        toolRole: "result",
        toolOk: result.ok,
        ...(!result.ok ? { tone: "error" as const } : {}),
        ...(hist ? { final: true } : {}),
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
  if (box.shape === "cell") {
    return [{ text: box.text ?? "", kind: kindOf(box), ...scope }];
  }
  // 会话区正文按物理行拆分交付：旧缓冲按物理行落行（keepLineBreaks），「块内空行
  // 竖线连排」等后处理逐行生效——单条行内嵌 \n 会走「含显式换行」孤立分支，丢竖线。
  // box 粒度不变（仍是一个结构段），只是行层展开与旧路径同粒度
  if (final) {
    return (box.text ?? "").split("\n").map((text) => ({
      text,
      kind: kindOf(box),
      final: true,
      ...scope,
    }));
  }
  // 回合区文本同样按**物理行**落行：`box.text` 以 \n 作行分隔，整段当一行输出会让终端
  // 把内嵌换行执行成真实换行、把后面内容顶到下面几行（真机 2026-10-09：回合区底行溢出，
  // 状态栏上方出现正文碎片；差分账本认为那些行未变，残留一直留到 Ctrl+L）。
  // **例外：user**——旧路径用户块整段入 buffer（state 的 keepLineBreaks 语义），物理行由
  // 渲染层 StyledText 折行时拆；在这里拆会变成「每物理行一个用户块」，状态符号与整块
  // 右对齐各来一次（真机 2026-10-09 复现：输入每行开头都多一个状态字符）。
  const shared = {
    kind: kindOf(box),
    ...(box.tone === undefined ? {} : { tone: box.tone }),
    // notice 排版参数（条目 7 选项 1）：/help 的悬挂缩进与紧凑豁免由节条目带到行上
    ...(box.hanging === undefined ? {} : { hanging: box.hanging }),
    ...(box.noCompact === true ? { noCompact: true } : {}),
    ...scope,
    // 用户块终态（条目 7 批 B1）：节上已定，行层直接带 `status`（解析器优先读它，
    // 不再回查 buffer）；`seq` 仍在（活跃块判定与旧路径兜底），B3 删 buffer 时一并去掉
    ...(box.userStatus === undefined ? {} : { status: box.userStatus }),
    // 被 steer 续接（批 B1）：行层带 `steerContinued` → 解析器出永久 `←`，不回查 buffer
    ...(box.steerContinued === true ? { steerContinued: true } : {}),
    // 活跃用户块（批 B1）：终态未定的最后一条用户输入 → 运行 ●/○ / 等待 △
    ...(active && box.source === "user" ? { active: true } : {}),
    // 用户行带行号：布局层用户块符号解析按 seq 回查 buffer 同源行
    ...(box.source === "user" && box.seqs?.[0] !== undefined
      ? { seq: box.seqs[0] }
      : {}),
  };
  const raw = box.text ?? "";
  // user：整段一行（行拆分交渲染层折行，见上）；
  if (box.source === "user") return [{ text: raw, ...shared }];
  // 非 user 文本：剥掉**前导 / 拖尾空行**（旧渲染器 `absorbActivityBlank` 口径，2026-10-10
  // 从 notice / shell 扩到全来源）——同源合并会把宿主补发的 "\n\n" 并进相邻正文（`sections.ts`
  // 按 source 合并），边缘空行在回合区与会话区都会占行；整段全空则该 box 不产出行。
  // 空白判定含零宽字符（U+200B/U+200C/U+2060/U+FEFF：`trim()` 不删但列宽为 0）。
  const lines = raw.split("\n");
  const blank = (text: string): boolean =>
    /^[\s\u200b\u200c\u2060\ufeff]*$/.test(text);
  let from = 0;
  let to = lines.length;
  while (from < to && blank(lines[from] ?? "")) from++;
  while (to > from && blank(lines[to - 1] ?? "")) to--;
  return lines.slice(from, to).map((text) => ({ text, ...shared }));
}

/** 表格容器 → 原始表格行（与旧缓冲的 markdown 形态逐字符一致）；会话区行带 final */
function tableLines(box: LayoutBox, dialogue: boolean): HistoryRow[] {
  const kind = kindOf(box);
  const final = dialogue && box.source === "assistant";
  const line = (text: string): HistoryRow => ({
    text,
    kind,
    ...(final ? { final: true } : {}),
  });
  const row = (cells: readonly string[]): string =>
    "| " + cells.join(" | ") + " |";
  const rows = box.children.filter(
    (child): child is LayoutBox =>
      child.kind === "layout" && child.role === "row",
  );
  const cellsOf = (row0: LayoutBox): string[] =>
    row0.children.map((cell) =>
      cell.kind === "content" ? (cell.text ?? "") : "",
    );
  const header = rows.find((row0) => row0.header === true);
  const out: HistoryRow[] = [];
  if (header !== undefined) out.push(line(row(cellsOf(header))));
  // 分隔行按**表头格数**生成（不是按 aligns 长度）：aligns 与表头格数一旦不一致
  // （上游任何一处补 / 丢格），按 aligns 生成会让分隔行比表头少列 → 旧渲染器
  // `isTableStart` 判不成表格 → 整表退回原样打印（真机实例：4 列表头 + 2 列分隔行）。
  // 对齐只决定 `---` / `---:` / `:---:`，缺的列按左对齐。
  const aligns = box.aligns ?? [];
  const ncols =
    header !== undefined
      ? cellsOf(header).length
      : rows[0] === undefined
        ? 0
        : cellsOf(rows[0]).length;
  if (ncols > 0) {
    out.push({
      text: row(
        Array.from({ length: ncols }, (_, j) => {
          const align = aligns[j];
          return align === "right"
            ? "---:"
            : align === "center"
              ? ":---:"
              : "---";
        }),
      ),
      kind,
      ...(final ? { final: true } : {}),
    });
  }
  for (const row0 of rows) {
    if (row0 === header) continue;
    out.push(line(row(cellsOf(row0))));
  }
  return out;
}

/** 来源 → 状态层的行类型（与旧路径同一分类口径） */
function kindOf(box: Box): HistoryRow["kind"] {
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
      return "assistant";
  }
}

/** pane 项 → 旧口径缓冲行（边界项按既有线型：step 头 / 回合分隔线 / 空行） */
function itemLines(item: PaneItem, dialogue: boolean): HistoryRow[] {
  switch (item.kind) {
    case "line":
      return boxToLines(item.box, dialogue, item.active === true);
    case "blank":
      return [{ text: "", kind: "plain" }];
    case "step-head":
      // 旧口径：step 头由 `appendToolLine` 插入（kind = tool），渲染为 `╌╌ hh:mm:ss ⇆N #M ╌╌`
      return [
        {
          text: stepHeaderLine(item.step, item.time, item.turn),
          kind: "tool",
        },
      ];
    case "step-summary":
      // P9 概要行：`kind: "step"` 由既有渲染器画成 `╌╌ <text> ` + 尾部 ╌ 铺满（会话区）
      return [{ text: item.text, kind: "step" }];
    case "turn-separator":
      // `untitled`（时间未知）= 纯虚线：不带 turn / time，既有渲染器按 `turnHeaderLine` 得空标签
      return [
        item.untitled === true
          ? { text: TURN_SEPARATOR, kind: "separator" }
          : {
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
    JSON.stringify(options.activityShow ?? {}),
    JSON.stringify(options.activityCompact ?? {}),
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
  const keys: string[] = [];
  const userRows: number[] = [];
  for (const item of items) {
    // 空行：直接出行，不经 `buildContentRows`——它会**裁掉首行空行**并把裸空 plain 行
    // 路由到会话区（活动区的空行会整行消失）。形状与旧路径的空行一致：无段、缩进 0、
    // kind plain（旧路径的空行节点同样只有这三个字段）。留白空行恒为**裸空行**：不继承
    // 相邻正文行的前导竖线（2026-10-16 裁定，会话区与回合区同口径）；块内空行的竖线连排
    // 仍归 `build-box.ts` 的 `lineUpBlockBars()`
    if (item.kind === "blank") {
      rows.push({ segments: [], indent: 0, kind: "plain" });
      counts.push(1);
      keys.push(item.key);
      continue;
    }
    const lines = itemLines(item, pane === "dialogue");
    if (lines.length === 0) {
      counts.push(0);
      keys.push(item.key);
      continue;
    }
    // 跳转目标：用户块首行（在本 pane 行缓冲里的绝对行号）
    if (
      pane === "dialogue" &&
      item.kind === "line" &&
      item.box.source === "user"
    )
      userRows.push(rows.length);
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
      keys.push(item.key);
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
    keys.push(item.key);
  }
  // 整 pane 末尾的空行不渲染（旧渲染器 `trimTrailingAssistantBlanks` 口径：只在 pane 末尾
  // 生效；逐项排版时各段看不到「谁是最后一行」，故在这里统一收尾）
  while (
    rows.length > 0 &&
    rows[rows.length - 1]!.segments.length === 0 &&
    rows[rows.length - 1]!.kind === "plain"
  ) {
    rows.pop();
    const last = counts.length - 1;
    if (last >= 0) counts[last] = Math.max(0, (counts[last] ?? 0) - 1);
  }
  return { rows, counts, keys, userRows, table: createLineTable(counts) };
}

// ================= 新链路（§3-§7）renderPane：接线桥 =================
//
// 旧 renderPaneLegacy（旧 PaneItem + buildBox/buildContentRows 六段）挂起不动，
// 本 renderPane 走新七段：buildTrees（含 user 块符号/右对齐/gutter）→ measure →
// flattenAttributed（逐 item 行归属）→ RenderedPane 契约（rows/counts/keys/
// userRows/table，加 kind/seq）。输出仍 ContentRow[]，帧层 consume 不变；
// 旧链函数在阶段 4 测试迁移后删除。

/** item → 稳定段键（滚动定位：段键 + 段内行；与旧键前缀一致） */
function newItemKey(item: NewPaneItem): string {
  if ("id" in item && typeof item.id === "string") return item.id;
  return (item as { key?: string }).key ?? "item";
}

/** item → 行身份（先宿主事件号，否则按稳定段键合成不变式序号） */
function newItemSeq(item: NewPaneItem, key: string): number {
  const seqs = (item as { seqs?: readonly number[] }).seqs;
  if (seqs !== undefined && seqs.length > 0) return seqs[0]!;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 5) + c + i), 0x85ebca6b) >>> 0;
  }
  return 1_000_000_000 + (h1 % 0x1000000) * 0x1000000 + (h2 % 0x1000000);
}

/** item → ContentRow.kind（frame 层只读 "tool-name" / "separator"，其余供分组/测试） */
function newItemKind(item: NewPaneItem, row?: NewRow): string {
  if (row?.rowKind !== undefined) return row.rowKind;
  switch (item.kind) {
    case "paragraph": {
      const source = (item as { source?: string }).source;
      switch (source) {
        case "user":
          return "user";
        case "reasoning":
          return "thinking";
        case "notice":
          return "notice";
        case "shell":
          return "shell";
        default:
          return "assistant";
      }
    }
    case "turn-header":
      return "separator";
    case "step-header":
      return "step-header";
    case "step-summary":
      return "step-summary";
    case "tool-batch":
      return "tool";
    default:
      return "plain";
  }
}

/** 是否为会话区用户块（跳转目标） */
function isNewUserItem(item: NewPaneItem): boolean {
  return (
    item.kind === "paragraph" && (item as { source?: string }).source === "user"
  );
}

/** 活动区紧凑类别（/collapse think|tool|reply；会话区不折叠） */
function compactCategory(
  item: NewPaneItem,
): "think" | "tool" | "reply" | undefined {
  switch (item.kind) {
    case "paragraph":
      return (item as { source?: string }).source === "reasoning"
        ? "think"
        : "reply";
    case "tool-batch":
      return "tool";
    default:
      return undefined;
  }
}

/** 紧凑折叠：多行条目压成单行（取首行 + 行尾省略号；逐像素对齐留阶段 4 人工 diff） */
function foldRow(row: NewRow, width: number): NewRow[] {
  const text = row.segments.map((s) => s.text).join("");
  if (text === "") return [row];
  void width;
  return [row];
}

/**
 * 新七段 renderPaneNew（§3-§7 一条龙，输出 RenderedPane 契约）。
 * 每 pane 分别以自身宽测量/摊平；user 块符号由 `userSym` 解析（缺 info 不显）。
 * 旧 `renderPane`（六段旧链）挂起供阶段 4 测试迁移；接线桥走本函数。
 */
export function renderPaneNew(
  items: readonly NewPaneItem[],
  pane: "dialogue" | "activity",
  options: PaneRenderOptions,
): RenderedPane {
  const width = Math.max(1, options.width);
  const vw = options.vw ?? width;
  const struct: StructureOptions = {
    userSym: options.userSym,
    gutter: options.gutter,
    normalize: options.normalize,
  };
  const { session, turn } = buildTrees(
    pane === "dialogue" ? items : [],
    pane === "activity" ? items : [],
    struct,
  );
  const root = pane === "dialogue" ? session : turn;
  measure(root, width, { vw });
  const perItem = flattenAttributed(root, width, { vw });
  const rows: ContentRow[] = [];
  const counts: number[] = [];
  const keys: string[] = [];
  const userRows: number[] = [];
  items.forEach((item, i) => {
    const key = newItemKey(item);
    keys.push(key);
    let produced = perItem[i] ?? [];
    if (pane === "activity") {
      const cat = compactCategory(item);
      if (cat !== undefined && options.activityCompact?.[cat]) {
        produced = produced.length > 0 ? foldRow(produced[0]!, width) : [];
      }
    }
    counts.push(produced.length);
    if (pane === "dialogue" && isNewUserItem(item)) userRows.push(rows.length);
    const seq = newItemSeq(item, key);
    for (const r of produced) {
      rows.push({
        segments: r.segments,
        kind: newItemKind(item, r),
        ...(r.indent === undefined ? {} : { indent: r.indent }),
        seq,
      });
    }
  });
  // 整 pane 末尾空行不渲染（旧 trimTrailingAssistantBlanks 同口径）
  while (
    rows.length > 0 &&
    rows[rows.length - 1]!.segments.length === 0 &&
    rows[rows.length - 1]!.kind === "plain"
  ) {
    rows.pop();
    const last = counts.length - 1;
    if (last >= 0) counts[last] = Math.max(0, (counts[last] ?? 0) - 1);
  }
  return { rows, counts, keys, userRows, table: createLineTable(counts) };
}
