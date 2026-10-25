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
} from "./ir.ts";

export type PaneTrees = { session: LayoutTree; turn: LayoutTree };
export type LayoutTree = Node | Leaf;

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

/** Paragraph → Leaf（正文 / 思考 / 用户 / notice / shell；分隔线 → 尾铺满） */
function toParagraph(block: Paragraph): Leaf {
  // 分隔线：不占文本，tail 铺满（flatten 据此产横线）
  if (block.rule === true) {
    return leaf([], { tail: { char: "─", style: { fg: "border" } } });
  }
  // 用户块：右对齐 + 右缘竖线（平衡折行，首行符号格见 toUser；正文普通处理）
  if (block.source === "user") return leaf(block.text, { balance: true });
  // 正文 / 思考：左缘竖线前缀
  return leaf(block.text, { prefix: bar(block.source) });
}

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

function toNodeItem(item: PaneItem): Node | Leaf | null {
  switch (item.kind) {
    case "paragraph":
      return toParagraph(item);
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
function toPaneTree(items: readonly PaneItem[]): LayoutTree {
  return {
    direction: "v",
    id: undefined,
    children: items.flatMap((item) => {
      const node = toNodeItem(item);
      return node === null ? [] : [node];
    }),
  };
}

/** 由 route 输出（或直接给定的两 pane 项）→ 两棵子树 */
export function buildTrees(
  session: readonly PaneItem[],
  turn: readonly PaneItem[],
): PaneTrees {
  return { session: toPaneTree(session), turn: toPaneTree(turn) };
}

/** 兼容口径：Record<PaneId, PaneItem[]> → 含 session / turn 的树 */
export function buildTree(
  panes: Partial<Record<PaneId, PaneItem[]>>,
): PaneTrees {
  return buildTrees(panes.session ?? [], panes.turn ?? []);
}

// ---------------- user 块：右对齐 + 状态符号格 ----------------

/**
 * 用户块特殊构图：会话区根节点为 h([符号格, 正文])（符号格首行 2 列），块整体
 * 右对齐 + 右缘竖线。本层只定形态，符号内容由调用方（布局层）经 `userStatus`
 * 解析器注入；无符号时退化为 h([]) 的单行正文。
 */
export function toUser(
  block: Paragraph,
  sym?: { text: string; fg?: string },
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
  return { direction: "h", children: kids };
}
