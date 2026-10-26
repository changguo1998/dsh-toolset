// src/app/layout/pipeline/structure.ts — §4 结构：PaneItem[] → Node/Leaf 树
//
// 职责（追踪文档 T27-T29）：把 §3 产出的扁平 PaneItem[]（markdown 块成品 + step /
// turn / gap / 概要占位 + 工具批）映射成 Node/Leaf 布局树。**宽无关**：宽度 / 折行 /
// 列宽 / 补白一律留给 §5 测量与 §6 摊平；本层只决定节点形态与装饰声明
// （prefix / suffix / tail / hanging / indent / width 族字段）。
//
// chrome 五 pane（tool / statusBar / statusCol / titleBar / input）由 layout 直接构图
// （追踪文档「偏差 ③」），本层只处理 session / turn 两 pane。

import { USER_MIN_LEFT_GUTTER } from "../content-rules.ts";
import { toolUnits } from "./boxes.ts";
import { stepHeaderLine, turnHeaderLine } from "../tool-line.ts";
import type { FrameStyle } from "../../../renderer/screen.ts";
import type {
  Block,
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

export type PaneTrees = { session: LayoutTree; turn: LayoutTree };
export type LayoutTree = Node | Leaf;

/** §4 结构阶段的 width 无关选项（块形态按它决定；width 相关一律留给 measure/flatten） */
export interface StructureOptions {
  /** P1/P7：用户块首行左侧状态符号（会话态解析；传入块携带的 UserRowInfo；undefined = 不显示） */
  userSym?: (info?: UserRowInfo) => { text: string; fg?: string } | undefined;
  /** 用户/助手右缘留白（旧 `gutter` 口径；右缘竖线占 1 列） */
  gutter?: number;
  /** 符号替换（symbol-normalizer 服务；缺省原文透传，作用于正文文本） */
  normalize?: (text: string) => string;
  /** 左缘 chrome 竖线（┃）开关：只属于对话(session)面板；活动(turn)面板不画
   *  （思考/流式正文为裸文本，legacy 同口径）。缺省 true。 */
  bar?: boolean;
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

// ---------------- 块 → 节点 ----------------

/** Quote → v Node：每个子行 = 左缘竖线 + `> ` 前缀 + 行内（旧 wrapAssistantLine 引用分支） */
function toQuote(block: Extract<Block, { kind: "quote" }>): Node {
  const barP = bar(block.source);
  return {
    direction: "v",
    children: (block.children as Paragraph[]).map((child) =>
      leaf([{ text: "> " }, ...child.text], {
        prefix: barP,
        // 续行悬挂对齐正文起列（> 之后的列）
        hanging: barP.text.length + 2,
      }),
    ),
  };
}

/** List → v Node：每个子项 = 左缘竖线 + 列表标记 + 行内（有序编号 / 任务框在 render 派生） */
function toList(block: Extract<Block, { kind: "list" }>): Node {
  const barP = bar(block.source);
  const children: Leaf[] = (block.items as Paragraph[]).map((item, index) => {
    const marker = markerFor(block, index);
    return leaf([{ text: marker }, ...item.text], {
      prefix: barP,
      hanging: barP.text.length + displayW(marker),
    });
  });
  return { direction: "v", children };
}

/** 列表项标记（有序按 items 索引生成的编号；无序 `• `；任务框由子段表达） */
function markerFor(
  block: Extract<Block, { kind: "list" }>,
  index: number,
): string {
  return block.ordered ? `${index + 1}. ` : "• ";
}

/** 显示宽（装饰占列需要） */
function displayW(text: string): number {
  // 宽度计算在 markdown.ts；此处引避免循环——列表 / 引用前缀都是半宽 ASCII
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2ff ? 2 : 1;
  return w;
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

/** ToolBatch → Node（载荷 tool：toolUnits 配对后的逻辑行单元；flatten 按宽折行渲染） */
function toToolBatch(batch: ToolBatch): Node {
  return { direction: "v", children: [], tool: toolUnits(batch) };
}

function toStepHeader(item: Extract<PaneItem, { kind: "step-header" }>): Leaf {
  return leaf(
    [{ text: `╌╌ ${stepHeaderLine(item.step, item.time, item.turn)} ` }],
    { tail: { char: "╌" } },
  );
}

function toTurnHeader(item: Extract<PaneItem, { kind: "turn-header" }>): Leaf {
  const label =
    item.untitled === true ? "" : turnHeaderLine(item.turn, item.time);
  return leaf(label === "" ? [] : [{ text: `╌╌ ${label} ` }], {
    tail: { char: "╌" },
  });
}

function toStepSummary(
  item: Extract<PaneItem, { kind: "step-summary" }>,
): Leaf {
  return leaf([{ text: `╌╌ ${item.text} ` }], { tail: { char: "╌" } });
}

function toGap(): Leaf {
  return { text: [] };
}

// ---------------- 入口 ----------------

/** 段落级归一：主题符号替换（normalize）后转 Leaf（user 块归 toUser 特殊处理） */
function paragraphLeaf(block: Paragraph, opts?: StructureOptions): Leaf | Node {
  // 用户块：符号格(h) + 右对齐 + 右缘竖线 + gutter（toUser）
  if (block.source === "user") {
    return toUser(block, opts?.userSym?.(block.user), opts?.gutter);
  }
  // 分隔线：不占文本，tail 铺满（flatten 据此产横线）
  if (block.rule === true) {
    return leaf([], { tail: { char: "─", style: { fg: "border" } } });
  }
  // 其它段落：normalize 作用于文本的实际字符（分段样式保留）；右缘预留 gutter
  const text = opts?.normalize
    ? applyNormalize(block.text, opts.normalize)
    : block.text;
  const barP = opts?.bar === false ? undefined : bar(block.source);
  return leaf(text, {
    ...(barP ? { prefix: barP } : {}),
    ...(opts?.gutter ? { rightGutter: opts.gutter } : {}),
  });
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

function toNodeItem(
  item: PaneItem,
  opts?: StructureOptions,
): Node | Leaf | null {
  switch (item.kind) {
    case "paragraph":
      return paragraphLeaf(item, opts);
    case "quote":
      return toQuote(item);
    case "list":
      return toList(item);
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
    case "step-summary":
      return toStepSummary(item);
    case "gap":
      return toGap();
  }
}

/** PaneItem[] → 单个 v 容器 Node（pane 的根；每个 PaneItem 一项） */
function toPaneTree(
  items: readonly PaneItem[],
  opts?: StructureOptions,
): LayoutTree {
  return {
    direction: "v",
    id: undefined,
    children: items.flatMap((item) => {
      const node = toNodeItem(item, opts);
      return node === null ? [] : [node];
    }),
  };
}

/** 由 route 输出（或直接给定的两 pane 项）→ 两棵子树 */
export function buildTrees(
  session: readonly PaneItem[],
  turn: readonly PaneItem[],
  opts?: StructureOptions,
): PaneTrees {
  return { session: toPaneTree(session, opts), turn: toPaneTree(turn, opts) };
}

/** 兼容口径：Record<PaneId, PaneItem[]> → 含 session / turn 的树 */
export function buildTree(
  panes: Partial<Record<PaneId, PaneItem[]>>,
  opts?: StructureOptions,
): PaneTrees {
  return buildTrees(panes.session ?? [], panes.turn ?? [], opts);
}

// ---------------- user 块：右对齐 + 状态符号格 ----------------

/**
 * 用户块特殊构图：会话区根节点为 h([符号格, 正文])（符号格首行 2 列），块整体
 * 右对齐 + 右缘竖线。本层只定形态，符号内容由调用方（布局层）经 `userSym`
 * 解析器注入；无符号时退化为 h([]) 的单行正文。`gutter` = 右缘保底留白列数
 * （1 列已被右缘竖线占用 → 其余 gutter-1 留白；有符号时符号格占 2 列，左侧留白
 * 再扣 2，使正文绝对起列与无符号时一致 —— 与旧 build-box 同口径）。
 */
export function toUser(
  block: Paragraph,
  sym?: { text: string; fg?: string },
  gutter = 0,
): Node {
  const body = leaf(block.text, {
    balance: true,
    suffix: {
      text: "┃",
      style: { fg: "brightRed" },
      minWidth: USER_MIN_LEFT_GUTTER + 2,
    },
  });
  const kids: (Node | Leaf)[] = [];
  if (sym !== undefined) {
    kids.push(
      leaf(
        [
          {
            text: sym.text,
            ...(sym.fg ? { color: sym.fg as StyledStr["color"] } : {}),
          },
          { text: " " },
        ],
        { widthStyle: "fixed", widthFixed: 2 },
      ),
    );
  }
  kids.push(body);
  const content: Node = { direction: "h", children: kids };
  // 右缘保底留白（gutter）+ 整块铺满 pane：fill spacer 恒在左侧（右对齐），
  // widthMin = gutter-1-符号格(2)；正文经 balance 取自然宽，spacer 吃剩余。
  const fillMin = Math.max(0, gutter - 1 - (sym ? 2 : 0));
  return {
    direction: "h",
    children: [
      leaf([], {
        widthStyle: "fill",
        ...(fillMin ? { widthMin: fillMin } : {}),
      }),
      content,
    ],
  };
}
