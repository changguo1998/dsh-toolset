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

import type { ActivitySwitches } from "../../state.ts";
import type { ContentRow } from "../fill.ts";
// ---- 新链路（§3-§7）接线桥 ----
import { isLeaf } from "./ir.ts";
import type {
  PaneItem as NewPaneItem,
  UserRowInfo,
  Row as NewRow,
} from "./ir.ts";
import type { StructureOptions } from "./structure.ts";
import { buildTrees } from "./structure.ts";
import { measure } from "./measure.ts";
import { flatten } from "./flatten.ts";
import { memlogTick } from "./memlog.ts";

/**
 * 渲染选项（帧层透传）：宽相关项由 `renderPaneNew` 消费，宽无关项在 structure 期消费。
 * （旧的六段链路已删除，这里只保留帧层实际用到的字段。）
 */
export interface RenderOptions {
  /** 会话区可用宽 */
  width: number;
  /** 回合区可用宽（缺省 = width） */
  activityWidth?: number;
  /** 用户 / 助手右缘留白（gutter） */
  gutter?: number;
  /** 活动区显示档位（`/verbose`：按类显隐） */
  activityShow?: Partial<ActivitySwitches>;
  /** 活动区紧凑档位（`/collapse`：按类折叠单行） */
  activityCompact?: Partial<ActivitySwitches>;
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
  /** 压缩剪枝遮蔽的块 id（整块打灰；来自 `route.shadowedBlockIds`） */
  shadowedIds?: ReadonlySet<string>;
  /**
   * 流活节 id 集合（来自 `state.current`）：这些节每帧重算、不入缓存（刷新型）。
   * 缓存只给「已定型历史」里**静态渲染**的 item（用户块符号仍实时，也重算）。
   */
  liveSectionIds?: ReadonlySet<string>;
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

let misses = 0;

/**
 * 新链 renderPaneNew 的摊平行缓存（**只缓存已定型历史的静态 item**；内容寻址键 =
 * pane/宽/紧凑 + 保留编号 + 内容签名，跨会话/内容变不串行）。会话与窗口（宽度）边界清场。
 */
const newRowCache = new Map<string, ContentRow[]>();

/** 每个 pane 上次排版宽度：窗口（宽度）一变 → 清空摊平缓存，measure 之后全部重算、不复用旧结果 */
const lastPaneWidth = new Map<string, number>();

/** 清空新链摊平行缓存（窗口 resize / 会话边界调用：measure 之后全部重算、不复用旧结果） */
export function clearNewRowCache(): void {
  newRowCache.clear();
  lastPaneWidth.clear();
}

/** 缓存未命中次数（计数断言用：宽度不变时同段不重复排版） */
export function rowRenderMisses(): number {
  return misses;
}

export function resetRowRenderStats(): void {
  misses = 0;
}

/**
 * 逐项出一行缓冲 + 行数表（宽度相关）。每一项独立走既有算法库：跨项的分隔与留白
 * 已由第 3 步的边界项表达，故此处不再做跨节点后处理。
 * 文本项按 (box 身份, 宽, 档位, 紧凑) 命中行缓存——宽度不变的重复帧不重排。
 */

// ================= 新链路（§3-§7）renderPane：接线桥 =================
//
// 新七段：buildTrees（含 user 块符号/右对齐/gutter）→ measure → flatten（逐槽位
// 摊平 + 按成员实测高度切片归行）→ RenderedPane 契约（rows/counts/keys/userRows/
// table，加 kind/seq）。输出 ContentRow[]，帧层 consume 不变。

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
 * 生产唯一入口（`frame.pipelineContent` 调用）。
 */
export function renderPaneNew(
  items: readonly NewPaneItem[],
  pane: "dialogue" | "activity",
  options: PaneRenderOptions,
): RenderedPane {
  const width = Math.max(1, options.width);
  const vw = options.vw ?? width;
  const prevPaneWidth = lastPaneWidth.get(pane);
  if (prevPaneWidth !== undefined && prevPaneWidth !== width) {
    // 该 pane 宽度真的变了(resize): 清空摊平缓存(宽已在键里, 变宽每个 item 键自然 miss)
    clearNewRowCache();
  }
  lastPaneWidth.set(pane, width);
  const struct: StructureOptions = {
    userSym: options.userSym,
    // 右缘 gutter 只作用于对话区（正文右缘留白）；活动区右缘由 pane 自身宽承担
    gutter: pane === "dialogue" ? options.gutter : undefined,
    // pane 形状（会话区 prefix "┃ " + 右缘留白 / 活动区单竖线无留白）由 buildTrees
    // 按树锁定，这里不再重复传
    normalize: options.normalize,
    ...(options.shadowedIds === undefined
      ? {}
      : { shadowedIds: options.shadowedIds }),
  };
  const trees = buildTrees(
    pane === "dialogue" ? items : [],
    pane === "activity" ? items : [],
    struct,
  );
  const root = pane === "dialogue" ? trees.session : trees.turn;
  const slots = pane === "dialogue" ? trees.sessionSlots : trees.turnSlots;
  measure(root, width, { vw });
  // 逐槽位摊平 + 缓存（槽位 = pane 根的一个顶层子节点，可能覆盖多个条目——分组合并时
  // 槽位数少于条目数）：**只缓存「已定型历史」里静态渲染的槽位**（非流活节、非用户块，
  // 用户块符号 / 工具相位为刷新型每帧重算）。键 = pane/宽/紧凑 + 成员键与内容签名。
  // 行归属 = 槽位行按各成员节点的实测高度切片（摊平行数 = Σ节点高度的不变式）。
  const keyHead = [
    pane,
    width,
    vw,
    options.gutter ?? "",
    JSON.stringify(options.activityCompact ?? {}),
  ].join("|");
  const liveIds = options.liveSectionIds;
  const perItem: ContentRow[][] = items.map(() => []);
  for (const slot of slots) {
    // 刷新型：流活节成员、用户块（符号实时）→ 不入缓存、每帧重算
    const isLive = slot.members.some((m) => {
      const item = items[m.index]!;
      const id = newItemKey(item);
      return (
        (item as { source?: string }).source === "user" ||
        (liveIds !== undefined &&
          liveIds.size > 0 &&
          [...liveIds].some((p) => id.startsWith(p + ":")))
      );
    });
    // 遮蔽状态进键：同一块在「被剪枝 / 未剪枝」下产出的行不同（打灰），不能互相复用
    const dimmed =
      options.shadowedIds !== undefined &&
      slot.members.some((m) => {
        const id = (items[m.index] as { id?: string }).id;
        return id !== undefined && options.shadowedIds!.has(id);
      });
    const ck =
      keyHead +
      (dimmed ? "|dim" : "") +
      "|" +
      slot.members
        .map((m) => {
          const item = items[m.index]!;
          return newItemKey(item) + "|" + JSON.stringify(item);
        })
        .join("\u0000");
    const cached = isLive ? undefined : newRowCache.get(ck);
    let produced = cached;
    if (produced === undefined) {
      if (!isLive) misses += 1;
      produced = flatten(slot.node, width, { vw });
      if (!isLive) {
        if (newRowCache.size > 8192) newRowCache.clear(); // 兜底防膨胀
        newRowCache.set(ck, produced);
      }
    }
    // 按成员实测高度切片；末成员吃掉余量（高度与实产行数不符时也不丢行）
    let offset = 0;
    slot.members.forEach((m, k) => {
      const isLast = k === slot.members.length - 1;
      const measured = Math.max(0, m.node.height ?? 0);
      const take = isLast
        ? Math.max(0, produced!.length - offset)
        : Math.min(measured, Math.max(0, produced!.length - offset));
      perItem[m.index] = produced!.slice(offset, offset + take);
      offset += take;
    });
  }
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
  memlogTick(rows.length);
  return { rows, counts, keys, userRows, table: createLineTable(counts) };
}
