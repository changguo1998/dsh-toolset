// src/app/layout/pipeline/structure.ts — §4 结构：PaneItem[] → Node/Leaf 树
//
// 职责（追踪文档 T27-T29）：把 §3 产出的扁平 PaneItem[]（markdown 块成品 + step /
// turn / gap / 概要占位 + 工具批）映射成 Node/Leaf 布局树。**宽无关**：宽度 / 折行 /
// 列宽 / 补白一律留给 §5 测量与 §6 摊平；本层只决定节点形态与装饰声明
// （prefix / suffix / tail / hanging / indent / width 族字段）。
//
// chrome 五 pane（tool / statusBar / statusCol / titleBar / input）由 layout 直接构图
// （追踪文档「偏差 ③」），本层只处理 session / turn 两 pane。

import {
  TOOL_FAIL_GLYPH,
  TOOL_OK_GLYPH,
  TOOL_PENDING_GLYPH,
  USER_MIN_LEFT_GUTTER,
} from "../content-rules.ts";
import { toolDiffSummary } from "../tool-line.ts";
import { displayWidth } from "../markdown.ts";
import { toolUnits } from "./tool-units.ts";
import { stepHeaderLine, turnHeaderLine } from "../tool-line.ts";
import type { FrameStyle } from "../../../renderer/screen.ts";
import type {
  Block,
  BlockSource,
  Leaf,
  Node,
  Paragraph,
  PaneItem,
  PaneId,
  StyledStr,
  StyledText,
  ToolBatch,
  UserRowInfo,
} from "./ir.ts";
import { isNode, sourceOf } from "./ir.ts";

/** 槽位成员：一个 PaneItem 与它在树里的节点（measure 后带 height） */
export interface SlotMember {
  /** items[] 里的下标 */
  index: number;
  node: Node | Leaf;
}

/**
 * 摊平槽位：pane 根的一个顶层子节点（一段可独立摊平的行来源）及其覆盖的条目。
 *
 * 分组合并（同一 section 的 user / assistant / reasoning 块共用一个盒）使槽位数可能
 * 少于条目数——行归属必须按本表切片，不能用 `items[i]` 对齐根 `children[i]`（早前正是
 * 按下标对齐，导致 counts / kind 错位、分隔线丢 ╌ 补白）。
 */
export interface PaneSlot {
  node: Node | Leaf;
  members: SlotMember[];
}

export type PaneTrees = {
  session: LayoutTree;
  turn: LayoutTree;
  sessionSlots: PaneSlot[];
  turnSlots: PaneSlot[];
};
export type LayoutTree = Node | Leaf;

/** §4 结构阶段的 width 无关选项（块形态按它决定；width 相关一律留给 measure/flatten） */
export interface StructureOptions {
  /** P1/P7：用户块首行左侧状态符号（会话态解析；传入块携带的 UserRowInfo；undefined = 不显示） */
  userSym?: (info?: UserRowInfo) => { text: string; fg?: string } | undefined;
  /** 用户/助手右缘留白（旧 `gutter` 口径；右缘竖线占 1 列） */
  gutter?: number;
  /** 压缩剪枝遮蔽的块 id（`route.shadowedBlockIds`）：命中的块整块打灰（颜色 → gray） */
  shadowedIds?: ReadonlySet<string>;
  /** 符号替换（symbol-normalizer 服务；缺省原文透传，作用于正文文本） */
  normalize?: (text: string) => string;
  /** 左缘 chrome 竖线（┃）开关：只属于对话(session)面板；活动(turn)面板不画
   *  （思考/流式正文为裸文本，legacy 同口径）。缺省 true。 */
  bar?: boolean;
  /** 目标 pane：盒形按面板区分（会话区形状已定，活动区未定） */
  pane?: "session" | "turn";
}

/** 左缘竖线（正文蓝 / 思考紫；窄窗降级阈值 = 最小留白 + 2） */
function bar(source: Block["source"]): {
  text: string;
  style?: FrameStyle;
  minWidth?: number;
} {
  return source === "reasoning"
    ? {
        text: "┃",
        style: { fg: "brightMagenta" },
        minWidth: USER_MIN_LEFT_GUTTER + 2,
      }
    : {
        text: "┃",
        style: { fg: "brightBlue" },
        minWidth: USER_MIN_LEFT_GUTTER + 2,
      };
}

function leaf(text: StyledText, extra: Partial<Leaf> = {}): Leaf {
  return { text, ...extra };
}
/**
 * 一段 StyledText → 物理行数组（按 `\n` 切，样式随段保留；空行 = 空数组）。
 * §4 起叶子内不再含换行：一行 = 一叶，measure / flatten 不必再处理物理换行。
 */
function splitTextLines(text: StyledText): StyledText[] {
  const out: StyledText[] = [[]];
  for (const s of text) {
    const parts = s.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) out.push([]);
      if (part !== "") out[out.length - 1]!.push({ ...s, text: part });
    });
  }
  return out;
}

/** 文本 → 行叶数组（一行一叶）；用于「标记提为节点 prefix」的容器（引用） */
function textLeaves(text: StyledText): Leaf[] {
  return splitTextLines(text).map((line) => leaf(line));
}

/**
 * 文本 → 单叶（单行）或多行 `v` 容器（一行一叶）。
 * `extra` 作用于每个叶（balance / hanging 等），`lineExtra(i)` 按行补充（列表 / 引用的
 * 续行缩进：首行不缩、后续行缩进到标记之后）。
 */
function textNode(
  text: StyledText,
  extra: Partial<Leaf> = {},
  lineExtra?: (index: number) => Partial<Leaf>,
): Node | Leaf {
  const lines = splitTextLines(text);
  const first = lines[0] ?? [];
  if (lines.length <= 1) return leaf(first, { ...extra, ...lineExtra?.(0) });
  return {
    direction: "v",
    children: lines.map((line, i) =>
      leaf(line, { ...extra, ...lineExtra?.(i) }),
    ),
  };
}

// ---------------- 块 → 节点 ----------------

/** Quote → v Node：`> ` 标记提为节点 `prefix`（每行装饰，与 `suffix` 同口径）；
 *  子块一律转成 **Box（Node）**，一块一盒——文本块的行叶在盒内，不直接铺到引用层。
 *  左缘竖线（┃）由外层 toBarBox 统一承担。 */
function toQuote(
  block: Extract<Block, { kind: "quote" }>,
  opts?: StructureOptions,
): Node {
  return {
    direction: "v",
    prefix: { text: "> " },
    children: block.children.map((child) => childBox(child, opts)),
  };
}

/** 子块 → 盒子（引用子块 / 列表条目共用）：文本块包成 `v`（行叶在盒内），
 *  其余块递归；叶级结果也垫一层 `v`——容器层的 children 因此恒为 Box。 */
function childBox(child: Block, opts?: StructureOptions): Node {
  if (child.kind === "paragraph")
    return { direction: "v", children: textLeaves(child.text) };
  const node = blockNode(child, opts);
  return isNode(node) ? node : { direction: "v", children: [node] };
}

/** List → v Node：**每条目一盒** `h[标记, 内容 v]`——标记单独占一列（不是文本前缘，
 *  也不是节点 `prefix`：`prefix` 是逐行装饰会重复标记），内容在标记右侧成盒。
 *  折行续行落在内容列下（悬挂 = 缩进 + 标记宽）。左缘竖线由外层 toBarBox 承担。 */
function toList(
  block: Extract<Block, { kind: "list" }>,
  opts?: StructureOptions,
): Node {
  // 逐条目标记（有序编号 / 任务复选框走 order，普通无序走 marker）。标记列宽 = **该条目
  // 自身标记的显示宽**（用户裁定：不统一列宽）；纯字符串度量，与可用宽无关，故在 §4 定死。
  // 嵌套层级同在本层落定：`indents[i]` = 该条目缩进列数（§2 parse 由前导缩进折算）。
  const marks = block.items.map(
    (_, i) => block.order?.[i] ?? block.marker ?? "• ",
  );
  const indents = block.items.map((_, i) => block.indents?.[i] ?? 0);
  return {
    direction: "v",
    children: block.items.map((item, i) =>
      listItemBox(item, marks[i]!, opts, indents[i]!),
    ),
  };
}

/** 列表条目 → `h[标记盒, 条目盒]`，两个子项都是 Box（容器层 children 恒为 Box）。
 *  标记取条目文本首段（parse 产出保证：`• ` / `1. ` / `[x] ` / `[ ] ` 各条目自带），
 *  其余文本按行拆叶进条目盒；非文本条目（嵌套块）直接成盒，没有标记列。 */
function listItemBox(
  item: Block,
  mark: string,
  opts?: StructureOptions,
  indent = 0,
): Node {
  // 标记格列宽 = 缩进 + 条目自身标记宽（不统一列宽 → 同层正文列不齐，属用户裁定口径）；
  // 缩进直接前置空格写进格内，续行折行因此悬挂到「缩进 + 标记宽」列。
  const markBox: Node = {
    direction: "v",
    widthStyle: "fixed",
    widthFixed: indent + Math.max(1, displayWidth(mark)),
    children: [
      mark === "" && indent === 0
        ? leaf([])
        : leaf([{ text: " ".repeat(indent) + mark }]),
    ],
  };
  const content =
    item.kind === "paragraph"
      ? { direction: "v" as const, children: textLeaves(item.text) }
      : childBox(item, opts);
  return { direction: "h", children: [markBox, content] };
}

/** 子块 → 节点（递归入口；任何块都必有节点，null 只对空项成立） */
function blockNode(child: Block, opts?: StructureOptions): Node | Leaf {
  return toNodeItem(child, opts) ?? leaf([]);
}

/** 用户块的右缘竖线后缀（整块外壳的后缀；brightRed） */
function userRightEdge(fg: StyledStr["color"] = "brightRed"): {
  text: string;
  style: FrameStyle;
  minWidth: number;
} {
  return {
    text: "┃",
    style: { fg },
    minWidth: USER_MIN_LEFT_GUTTER + 2,
  };
}

/** 排队块的右缘竖线颜色（旧口径同款）：steer 黄 / followup 灰；非排队（已发出）返回
 *  undefined → 由 `userRightEdge` 的默认值给亮红 */
function queuedEdgeFg(
  user: UserRowInfo | undefined,
): StyledStr["color"] | undefined {
  if (user?.queued === "steer") return "brightYellow";
  if (user?.queued !== undefined) return "gray";
  return undefined;
}

/** 用户块外壳（用户给定结构）：一条用户输入 = 一个 h 节点
 *
 *   { direction: h, suffix: "┃",
 *     children: [ spacer, 状态符号格, 内容 { direction: v } ] }
 *
 *  状态符号格是 `widthFixed = 符号显示宽 + 1` 的固定宽盒，盒内叶**只放符号本身**（不带
 *  尾随空格）；差的 1 列由摊平（`flattenH` 按子项宽补白）补成符号与正文之间的间隙。
 *
 *  内容 v 的子节点是这条输入解析出的全部块（段落 / 列表 / 代码）；摊平后各行同宽，
 *  故块与块左缘、右缘都对齐。右对齐只靠 spacer(fill) 吃剩余列（节点不带 `align`），
 *  补白因此落在内容左侧。导出供单测直接验形态；生产路径只经 `toPaneTree` 调用。 */
export function toUserBox(
  sym: { text: string; fg?: string } | undefined,
  children: (Node | Leaf)[],
  gutter: number,
  edgeFg?: StyledStr["color"],
): Node {
  const box: Node = {
    direction: "h",
    suffix: userRightEdge(edgeFg),
    children: [],
  };
  // spacer = Box(fill, "")：吃掉剩余列，把内容推到右侧
  box.children.push({
    direction: "v",
    widthStyle: "fill",
    ...(gutter > 0 ? { widthMin: Math.max(0, gutter - 1) } : {}),
    children: [leaf([])],
  });
  if (sym !== undefined) {
    // 符号格 = Box(widthFixed: 符号宽 + 1)：叶里只放符号，间隙的 1 列交给摊平补白
    box.children.push({
      direction: "v",
      widthStyle: "fixed",
      widthFixed: displayWidth(sym.text) + 1,
      children: [
        leaf([
          {
            text: sym.text,
            ...(sym.fg ? { color: sym.fg as StyledStr["color"] } : {}),
          },
        ]),
      ],
    });
  }
  // 内容 v 取自然宽（auto）；spacer(fill) 吃剩余 → 整块右对齐
  box.children.push({ direction: "v", children });
  return box;
}

/** 条目上的用户运行时态（用户块首行状态符号的素材；非用户条目返回 undefined） */
function userOf(block: PaneItem): UserRowInfo | undefined {
  return (block as { user?: UserRowInfo }).user;
}

/** Code → Node（载荷 code；measure / flatten 各自消费） */
function toCode(block: Extract<Block, { kind: "code" }>): Node {
  return {
    direction: "v",
    children: [],
    code: { lang: block.lang ?? "", rows: block.rows, closed: block.closed },
  };
}

/** Table → Node（载荷 table；measure fitCols 定列宽、flatten 排网格） */
function toTable(block: Extract<Block, { kind: "table" }>): Node {
  return {
    direction: "v",
    children: [],
    table: { aligns: block.aligns, header: block.header, rows: block.rows },
  };
}

/**
 * ToolBatch → `v` 容器，每条逻辑行一个 `h` 盒：
 *
 *   Box(v)[
 *     Box(h)[Box(v,fixed 2)[Leaf(相位字形)],  Box(v,fill)[Leaf(名字, 黄)]],         // 名字行
 *     Box(h)[Box(v,fixed 4)[Leaf("")],        Box(v,fill)[Leaf("name value")]],     // 参数行
 *     Box(h)[Box(v,fixed 2)[Leaf(✓/✗ 或空)],  Box(v,fill)[Leaf(结果, 失败红)]],      // 结果行
 *   ]
 *
 * 固定宽标记盒提供首行缩进，`flattenH` 给缺行补同宽空白 → 续行自动悬挂；
 * 行类型挂在叶子的 `rowKind` 上（帧层据此改写工具名相位字形）。
 * 长名字的收束 / 折行由全局折叠档位（`activityCompact.tool`）在帧层控制，不在节点上截断。
 */
function toToolBatch(batch: ToolBatch): Node {
  const children: Node[] = [];
  for (const unit of toolUnits(batch)) {
    if (unit.role === "name") {
      const pending = unit.result === undefined;
      const glyph = pending
        ? TOOL_PENDING_GLYPH
        : unit.result.ok
          ? TOOL_OK_GLYPH
          : TOOL_FAIL_GLYPH;
      const glyphColor = pending ? "yellow" : unit.result.ok ? "green" : "red";
      children.push(
        rowBox(2, leaf([{ text: glyph, color: glyphColor }]), [
          leaf([{ text: unit.call.name, color: "yellow" }], {
            rowKind: "tool-name",
          }),
        ]),
      );
    } else if (unit.role === "param") {
      // 参数行：`h[缩进 4, h[标记 2, 剩余文本]]`
      // 标记盒装「变量名前两个字符」而不是空白 —— 名字因此起于第 4 列，折行续行落在
      // 标记盒之后（第 6 列），相对名字 +2。
      const name = unit.param.name;
      const text =
        name === "" ? unit.param.value : name + " " + unit.param.value;
      const { head, rest } = splitHead(text, 2);
      const body = rowBox(2, leaf(head === "" ? [] : [{ text: head }]), [
        leaf(rest === "" ? [] : [{ text: rest }], { rowKind: "tool-param" }),
      ]);
      // 内层 h 取 fill：否则其自然宽只算到标记盒宽（fill 子项自然宽按 widthMin 计），
      // 会把文本压成每行 1 列
      body.widthStyle = "fill";
      children.push({
        direction: "h",
        children: [
          {
            direction: "v",
            widthStyle: "fixed",
            widthFixed: 4,
            children: [leaf([])],
          },
          body,
        ],
      });
    } else {
      const text = toolResultText(unit.result);
      if (text === "") continue;
      const fail = unit.result.ok !== true;
      const orphan = unit.orphan === true;
      const marker = orphan ? (fail ? "✗ " : "✓ ") : "";
      const markerColor = fail ? ("red" as const) : ("green" as const);
      children.push(
        rowBox(
          2,
          leaf(marker === "" ? [] : [{ text: marker, color: markerColor }]),
          [
            leaf([{ text, ...(fail ? { color: "red" as const } : {}) }], {
              rowKind: "tool-result",
            }),
          ],
        ),
      );
    }
  }
  return { direction: "v", children };
}

/** 按显示宽切出前 `w` 列（首段给标记盒，余下进文本盒） */
function splitHead(text: string, w: number): { head: string; rest: string } {
  let head = "";
  let used = 0;
  let i = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (used + cw > w) break;
    head += ch;
    used += cw;
    i += 1;
  }
  return { head, rest: text.slice(i) };
}

/** 工具结果一行的文本：去尾空白 + 行级 diff 摘要（与旧 `flattenTool` 同口径） */
function toolResultText(result: { detail: string; meta?: unknown }): string {
  const detail = result.detail.replace(/\s+$/, "");
  const diff = toolDiffSummary(result.meta);
  if (diff === undefined) return detail;
  const at = detail.indexOf("\n");
  if (at < 0) return detail === "" ? diff : detail + " " + diff;
  return detail.slice(0, at) + " " + diff + detail.slice(at);
}

/** 行盒：固定宽标记列 + 填满剩余列的内容盒 */
function rowBox(
  markW: number,
  mark: Node | Leaf,
  content: (Node | Leaf)[],
): Node {
  return {
    direction: "h",
    children: [
      {
        direction: "v",
        widthStyle: "fixed",
        widthFixed: markW,
        children: [mark],
      },
      { direction: "v", widthStyle: "fill", children: content },
    ],
  };
}

/**
 * 分隔头统一形状：`Box(h, [文本盒, tail 填充盒])`
 *
 * - 文本盒：`Box(v)[Leaf(label)]`（标签原文，含首尾 `╌╌ ` / 空格）
 * - tail 盒：`widthStyle: "fill"` 吃满剩余列，内空叶带 `tail: ╌` → 逐格铺满
 *   颜色 / 宽度都由 flatten 读节点字段得出，不在本节现造。
 */
/** 头行：左侧标签 + 右侧填充线占满整行（标签为空则整行只有填充线） */
function toHeader(label: StyledText): Node {
  const fill: Node = {
    direction: "v",
    widthStyle: "fill",
    fillWith: { text: "╌" },
    children: [leaf([])],
  };
  return {
    direction: "h",
    widthStyle: "fill",
    children:
      label.length === 0
        ? [fill]
        : [{ direction: "v", children: [leaf(label)] }, fill],
  };
}

function toStepHeader(item: Extract<PaneItem, { kind: "step-header" }>): Node {
  return toHeader([
    { text: `╌╌ ${stepHeaderLine(item.step, item.time, item.turn)} ` },
  ]);
}

function toTurnHeader(item: Extract<PaneItem, { kind: "turn-header" }>): Node {
  const label =
    item.untitled === true ? "" : turnHeaderLine(item.turn, item.time);
  return toHeader(label === "" ? [] : [{ text: `╌╌ ${label} ` }]);
}

/** 空行（Gap）：与头部同形但不带 tail——`Box(h)[空文本盒]`，摊平出一行空行 */
function toGap(): Node {
  return {
    direction: "h",
    widthStyle: "fill",
    fillWith: { text: " " },
    children: [{ direction: "v", children: [leaf([])] }],
  };
}

// ---------------- 入口 ----------------

/** 段落 → 叶（单行）或多行 v 容器（一行一叶）；用户段落 balance（自然宽取内容宽，
 *  配合用户盒 spacer 右对齐）。盒子与竖线由 toPaneTree 统一生成 */
function paragraphLeaf(block: Paragraph, opts?: StructureOptions): Leaf | Node {
  if (block.source === "user") return textNode(block.text, { balance: true });
  // 分隔线：不占文本，tail 铺满（flatten 据此产横线）
  if (block.rule === true) {
    // 分隔线：一个 fill 盒，用 `─` 补满整宽（不再借 tail 字段）
    return {
      direction: "v",
      widthStyle: "fill",
      fillWith: { text: "─", color: "border" },
      children: [leaf([])],
    };
  }
  // 其它段落：normalize 作用于文本的实际字符（分段样式保留）；右缘 gutter / 竖线由外层 toBarBox 承担
  const text = opts?.normalize
    ? applyNormalize(block.text, opts.normalize)
    : block.text;
  const node = textNode(text);
  // 悬挂缩进（/help 双列表格等）：续行停靠列交给 §6 摊平
  if (block.hanging === undefined) return node;
  return { ...node, hanging: block.hanging };
}

/** 对段落文本逐 StyledStr 应用文本替换（保留样式，仅改 text） */
function applyNormalize(
  text: StyledText,
  normalize: (t: string) => string,
): StyledText {
  return text.map((s) =>
    s.text === "" ? s : { ...s, text: normalize(s.text) },
  );
}

/** 块 → 节点（命中遮蔽集合时打 `dim` 标记，颜色落 §6 摊平） */
/** 条目 → 节点（不打灰：打灰标记统一由 `toPaneTree` 打在 slot 的最外层盒上） */
function toNodeItem(
  item: PaneItem,
  opts?: StructureOptions,
): Node | Leaf | null {
  return toNodeItemRaw(item, opts);
}

function toNodeItemRaw(
  item: PaneItem,
  opts?: StructureOptions,
): Node | Leaf | null {
  switch (item.kind) {
    case "paragraph":
      return paragraphLeaf(item, opts);
    case "quote":
      return toQuote(item, opts);
    case "list":
      return toList(item, opts);
    case "code":
      return toCode(item);
    case "table":
      return toTable(item);
    case "tool-batch":
      return toToolBatch(item);
    case "step-header":
      return toStepHeader(item);
    case "turn-header":
      return toTurnHeader(item);
    case "gap":
      return toGap();
    default:
      return null;
  }
}

/**
 * PaneItem[] → pane 根（单个 v 容器）+ 槽位表（每个顶层子节点 → 它覆盖的条目）。
 * 同一 section 的 user / assistant / reasoning 块合并进同一个盒，故槽位数可能少于条目数。
 */
function toPaneTree(
  items: readonly PaneItem[],
  opts?: StructureOptions,
): { root: LayoutTree; slots: PaneSlot[] } {
  const out: (Node | Leaf)[] = [];
  const slots: PaneSlot[] = [];
  // 层级：pane 根 → 每段一个盒（同 `source + section` 的条目并进同一盒）。回合分隔线 /
  // step 头属于紧随其后的那一段（排在各块之前、同一槽位）：行内不画段盒的左竖线，
  // 右端停在正文右缘（见 headerRowBox）；攒不到后续段时按独立槽位收尾。
  const pending: { node: Node | Leaf; index: number }[] = [];
  const flushPending = (): void => {
    while (pending.length > 0) {
      const head = pending.shift()!;
      const node = headerRowBox(head.node as Node | Leaf);
      out.push(node);
      slots.push({ node, members: [{ index: head.index, node }] });
    }
  };
  for (let i = 0; i < items.length; i++) {
    const key = groupKeyOf(items[i]!);
    if (key === undefined) {
      // 头类条目：攒进紧随其后的段（找不到后续段时按独立槽位收尾，不丢行）
      if (isHeaderItem(items[i]!)) {
        const built = toNodeItem(items[i]!, opts);
        if (built !== null) pending.push({ node: built, index: i });
        continue;
      }
      flushPending();
      const built = toNodeItem(items[i]!, opts);
      if (built !== null) {
        const node: Node | Leaf = shadowed(items[i]!, opts)
          ? { ...built, dim: true }
          : built;
        out.push(node);
        slots.push({ node, members: [{ index: i, node }] });
      }
      continue;
    }
    const inner: (Node | Leaf)[] = [];
    const members: SlotMember[] = [];
    const src = sourceOf(items[i]!) ?? "assistant";
    // 头行（回合分隔线 / step 头）与段内各块平级：正文 / 思考段直接塞进内容 v（标裸行，
    // 由 toBarBox 提到装饰盒之外、段盒之内，从而不画左竖线）；用户段是右对齐盒
    // （spacer + 符号 + 内容），头行进不去它的内容列，一并提到段盒外层（v[头行, 用户盒]）。
    const heads = [...pending];
    pending.length = 0;
    const inline = src === "user" ? [] : heads;
    const hoisted = src === "user" ? heads : [];
    for (const p of inline) {
      const node = bareNode(p.node);
      inner.push(node);
      members.push({ index: p.index, node });
    }
    let j = i;
    for (; j < items.length && groupKeyOf(items[j]!) === key; j++) {
      const node = toNodeItem(items[j]!, opts);
      if (node !== null) {
        inner.push(node);
        members.push({ index: j, node });
      }
    }
    const built =
      src === "user"
        ? toUserBox(
            opts?.userSym?.(userOf(items[i]!)),
            inner,
            opts?.gutter ?? 0,
            queuedEdgeFg(userOf(items[i]!)),
          )
        : toBarBox(bar(src), inner, opts);
    // 打灰标记顶到盒外层：§6 摊平只认一个入口（盒节点），缓存键也读这一处
    const dimmed = members.some((m) => shadowed(items[m.index]!, opts));
    const boxNode: Node = dimmed ? { ...built, dim: true } : built;
    // 用户段：槽位 = v[头行盒…, 用户盒]（头行整行铺满 pane，右端与用户块右缘对齐）
    const headNodes = hoisted.map((p) => p.node as Node);
    const node: Node =
      headNodes.length === 0
        ? boxNode
        : { direction: "v", children: [...headNodes, boxNode] };
    out.push(node);
    slots.push({
      node,
      members: [
        ...hoisted.map((p, k) => ({ index: p.index, node: headNodes[k]! })),
        ...members,
      ],
    });
    i = j - 1;
  }
  flushPending();
  return { root: { direction: "v", id: undefined, children: out }, slots };
}

/** 分隔线类条目（回合分隔线 / step 头）：与 reason / assistant / user / call 平级的行 */
function isHeaderItem(item: PaneItem): boolean {
  return item.kind === "step-header" || item.kind === "turn-header";
}

/** 分隔线头行盒：`v fill[头内容]`——不画左竖线，横向铺满整个 pane，
 *  右端停在 pane 文字右缘（与用户块右竖线同列）。 */
function headerRowBox(child: Node | Leaf): Node {
  return { direction: "v", widthStyle: "fill", children: [child] };
}

/** 标裸行：交给 toBarBox 提到装饰盒之外（不画段盒左竖线 / 右缘留白），只占正文列 */
function bareNode<T extends Node | Leaf>(node: T): T {
  return { ...node, bare: true };
}

/**
 * 分组键：同一条输入 / 同一个正文或思考节（不参与分组的条目返回 undefined）。
 *
 * **必须是值语义**：早前返回 `{ source, section }` 对象字面量又用 `===` 比较——两次调用
 * 永不相等，收集循环的 `j` 不前进、`i = j - 1` 使外层原地打转 → 死循环 + 无界堆积（OOM）。
 */
function groupKeyOf(item: PaneItem): string | undefined {
  const source = sourceOf(item);
  const section = (item as { section?: string }).section;
  if (section === undefined) return undefined;
  if (source !== "user" && source !== "assistant" && source !== "reasoning")
    return undefined;
  return source + "\u0000" + section;
}

/** 该条目是否命中压缩剪枝遮蔽集合（打灰判定的唯一出处） */
function shadowed(item: PaneItem, opts?: StructureOptions): boolean {
  const id = (item as { id?: string }).id;
  return id !== undefined && opts?.shadowedIds?.has(id) === true;
}

/** 会话区右缘留白（`gutter − 1` 个空格；gutter 记左右合计、竖线占 1 列）：正文盒与
 *  分隔线头共用同一份，保证两者的右缘落在同一列。活动区无右缘留白。 */
function edgeSuffix(opts?: StructureOptions): { text: string } | undefined {
  if (opts?.pane === "turn") return undefined;
  const gutter = Math.max(0, opts?.gutter ?? 0);
  return gutter > 1 ? { text: " ".repeat(gutter - 1) } : undefined;
}

/** 正文 / 思考盒：盒形按 pane 区分。
 *
 *  - **会话区**（形状已定）：`h[prefix "┃", 内容 v, suffix 空格]`——竖线后**不带空格**，
 *    正文直接接在竖线之后（前缀计 1 列）；右缘留白 = `gutter − 1` 个空格（gutter 记左右
 *    合计：gutter=4 → 3 个空格），逐行绘制。
 *  - **活动区**（形状未定）：单竖线 `┃`、无右缘留白。 */
function toBarBox(
  barP: { text: string; style?: FrameStyle; minWidth?: number },
  children: (Node | Leaf)[],
  opts?: StructureOptions,
): Node {
  // 分隔线头（裸行）与段内各块平级，但不画竖线、只占正文列：提到装饰盒之外、段盒之内
  const heads = children.filter((c) => (c as { bare?: true }).bare === true);
  const body = children.filter((c) => (c as { bare?: true }).bare !== true);
  // 内容盒取 fill：占据左侧装饰之后的全部剩余列（auto 会被自然宽收紧——分隔线 / 空行这类
  // 无文本内容自然宽为 1，会退化成 1 列）
  const inner: Node = { direction: "v", widthStyle: "fill", children: body };
  const suffix = edgeSuffix(opts);
  const box: Node =
    opts?.pane === "turn"
      ? { direction: "h", prefix: barP, children: [inner] }
      : {
          direction: "h",
          prefix: barP,
          ...(suffix === undefined ? {} : { suffix }),
          children: [inner],
        };
  if (heads.length === 0) return box;
  // 头行盒：与段盒同款右缘留白（不带左竖线），右端因此与正文右缘同列
  const headBoxes = heads.map((child) => headerRowBox(child));
  return { direction: "v", children: [...headBoxes, box] };
}

/** 由 route 输出（或直接给定的两 pane 项）→ 两棵子树 */
export function buildTrees(
  session: readonly PaneItem[],
  turn: readonly PaneItem[],
  opts?: StructureOptions,
): PaneTrees {
  // 每棵树锁定自己的 pane 形状：会话区 prefix "┃ " + 右缘留白，活动区单竖线无留白
  // （此前调用方漏传 pane 时活动区会被套成会话壳）
  const sess = toPaneTree(session, { ...opts, pane: "session" });
  const turnTree = toPaneTree(turn, { ...opts, pane: "turn" });
  return {
    session: sess.root,
    turn: turnTree.root,
    sessionSlots: sess.slots,
    turnSlots: turnTree.slots,
  };
}

// ---------------- user 块：h(spacer, 符号, 内容 v) + 右缘后缀 ----------------
