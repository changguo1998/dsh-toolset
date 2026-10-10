// src/app/layout/pipeline/boxes.ts — 第 2 步「结构」：节 → box 树（**宽无关**）
//
// 结构（节间扁平、节内嵌套；对齐旧 box.ts 的容器 / 叶子两族）：
//   节 → 类型块 LayoutBox（role "block"，source = reasoning/assistant/tool/notice/user/shell）
//         └─ 细分 ContentBox（叶子，只保存内容）：
//              assistant: text（正文） / quote（引用） / list（列表） / code（围栏代码）
//                         / table（表格容器，见下）
//              tool:      tool（整批：调用 1..N + 结果 1..N）
//              其余来源:  text
//         表格细分为 LayoutBox（role "table"）→ 行 LayoutBox（role "row"）→ 单元格
//         ContentBox（shape "cell"）。单元格视情况再往下拆——当前单元格均为单行文本，
//         拆分止于单元格；出现多行 / 结构化单元格时在本层扩展。
//
// 其余口径不变：结构识别在这一层（围栏 / 表格 / 列表 / 引用），**不插任何分隔内容**
// （空行 / step 头 / 回合分隔线由第 3 步按相邻 box 推导）；宽度相关（代码折行、行号列、
// 表格列宽、紧凑截断）一律留给第 4 步。
//
// 与旧路径的差异（有意）：围栏配对只看本条目文本，不看其他行——旧实现「未闭合 ⇒ 跳到
// 窗口末尾」会丢掉其后全部内容（BACKLOG 缺陷条目 / R7），新口径结构上不可能发生。

import { isTableStart, parseTableAt, type TableAlign } from "../table.ts";
import type { Item, Section, Source } from "./types.ts";

/** 叶子结构类别 */
export type Shape = "text" | "quote" | "list" | "code" | "cell" | "tool";

/** 代码块（宽无关：只有语言标记与原文行；行号列 / 折行在第 4 步） */
export interface CodeBox {
  lang: string;
  lines: string[];
  /** 围栏是否闭合（未闭合 = 条目文本用尽；仍是普通代码块，不吞后续内容） */
  closed: boolean;
}

/** 工具批：调用 1..N + 结果 1..N 合成一个叶子（内部保留各条 callId / name / args / 状态） */
export interface ToolBatch {
  calls: NonNullable<Item["calls"]>;
  results: NonNullable<Item["results"]>;
}

/** 共同字段：归属 + 宿主事件号 + 遮蔽标记 */
interface BoxBase {
  turn: number;
  step: number;
  source: Source;
  /** 该节点覆盖的宿主事件号（来自条目账；压缩剪枝遮蔽判定用） */
  seqs?: readonly number[];
  /** 压缩剪枝遮蔽（`compaction/prune`）：整块渲染成灰，内容与行数不变 */
  shadowed?: boolean;
  /** steer 插队送达的用户块（第 3 步据此在它之前留空行） */
  steer?: boolean;
  /** 用户块终态（节上的 `userStatus` 透传）：行层写 `status`，符号不再回查 buffer */
  userStatus?: "success" | "failure" | "aborted";
  /** 被 steer 续接过的用户块（批 B1）：行层写 `steerContinued` → 永久 `←` */
  steerContinued?: boolean;
}

/** 叶子 box：只保存内容，不再包含子节点 */
export interface ContentBox extends BoxBase {
  kind: "content";
  shape: Shape;
  /** 文本类原文（text / quote / list / cell；未拆行、未替换符号） */
  text?: string;
  code?: CodeBox;
  batch?: ToolBatch;
  /** notice 分级（来源条目的 tone 透传） */
  tone?: Item["tone"];
  /** notice 排版参数（条目 7 选项 1）：悬挂缩进列与紧凑豁免（/help 双列表格用） */
  hanging?: number;
  noCompact?: boolean;
}

/** 容器 box：可嵌套 LayoutBox 与 ContentBox */
export interface LayoutBox extends BoxBase {
  kind: "layout";
  /** 容器语义：block = 类型块（第一级）；table = 表格；row = 表格行 */
  role: "block" | "table" | "row";
  /** 表格列对齐（role = "table"） */
  aligns?: readonly TableAlign[];
  /** 是否表头行（role = "row"） */
  header?: boolean;
  children: readonly Box[];
}

/** box 节点 = 容器 | 叶子 */
export type Box = LayoutBox | ContentBox;

/** 围栏开关行（与旧路径同一正则口径：最多 3 空格缩进 + 3 个以上反引号 / 波浪号 + 可选语言） */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w.+-]*)[ \t]*$/;

/** 该行是否为围栏开关行；命中返回语言标记 */
function fenceLang(line: string): string | undefined {
  const match = FENCE_RE.exec(line);
  return match === null ? undefined : (match[2] ?? "");
}

/** 引用行（最多 3 空格缩进 + `>`） */
const QUOTE_RE = /^ {0,3}>/;

/** 列表项行（`-` / `*` / `+` 或有序 `1.` / `1)`，后接空白或行尾） */
const LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/** 列表项的缩进续行（更深的空白开头的内容行，归属上一个列表项） */
const LIST_CONT_RE = /^\s{2,}\S/;

/** 文本条目 → 细分 ContentBox 序列：正文 / 引用 / 列表 / 代码块 / 表格逐段拆。
 *  结构细分仅对 assistant：用户块是逐字原文（不做 markdown 结构拆分，否则一个输入
 *  被拆成多个块、状态符号重复），思考 / notice / shell 同样保持整段文本。 */
function textParts(item: Item, turn: number, step: number): Box[] {
  const text = item.text ?? "";
  if (text === "") return [];
  if (item.source !== "assistant") {
    return [
      {
        kind: "content",
        turn,
        step,
        source: item.source,
        shape: "text",
        text,
        ...(item.tone === undefined ? {} : { tone: item.tone }),
        ...(item.hanging === undefined ? {} : { hanging: item.hanging }),
        ...(item.noCompact === true ? { noCompact: true } : {}),
        ...(item.seqs === undefined ? {} : { seqs: item.seqs }),
        ...(item.userStatus === undefined
          ? {}
          : { userStatus: item.userStatus }),
        ...(item.steerContinued === true ? { steerContinued: true } : {}),
      },
    ];
  }
  const lines = text.split("\n");
  const parts: Box[] = [];
  let run: string[] = [];
  let quote: string[] = [];
  let list: string[] = [];
  const part = (shape: Shape, lines0: string[]): ContentBox => ({
    kind: "content",
    turn,
    step,
    source: item.source,
    shape,
    text: lines0.join("\n"),
    ...(item.tone === undefined ? {} : { tone: item.tone }),
    ...(item.seqs === undefined ? {} : { seqs: item.seqs }),
  });
  const flushText = (): void => {
    if (run.length === 0) return;
    parts.push(part("text", run));
    run = [];
  };
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    parts.push(part("quote", quote));
    quote = [];
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    parts.push(part("list", list));
    list = [];
  };
  const flushAll = (): void => {
    flushText();
    flushQuote();
    flushList();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lang = fenceLang(line);
    if (lang !== undefined) {
      // 围栏开启：向后收集代码行，直到同类闭合围栏（不足 3 个 / 不同字符不算）
      flushAll();
      const open = line.trimStart().startsWith("~") ? "~" : "`";
      const code: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const inner = lines[j] ?? "";
        const innerLang = fenceLang(inner);
        if (innerLang !== undefined && inner.trimStart().startsWith(open)) {
          closed = true;
          break;
        }
        code.push(inner);
      }
      parts.push({
        kind: "content",
        turn,
        step,
        source: item.source,
        shape: "code",
        code: { lang, lines: code, closed },
        ...(item.seqs === undefined ? {} : { seqs: item.seqs }),
      });
      // 未闭合 = 本条目文本用尽：游标停在文本末尾，**不吞**后续条目 / box
      i = closed ? j : lines.length;
      continue;
    }
    const next = lines[i + 1];
    if (
      next !== undefined &&
      !line.includes("\n") &&
      isTableStart(line, next)
    ) {
      const parsed = parseTableAt(lines, i);
      if (parsed !== null && parsed.table.rows.length >= 0) {
        flushAll();
        parts.push(tableTree(parsed.table, turn, step, item.source, item.seqs));
        i = parsed.end - 1;
        continue;
      }
    }
    if (QUOTE_RE.test(line)) {
      // 引用行：结束正文 / 列表 run，引用 run 连续收集（空行 / 其他结构结束引用）
      flushText();
      flushList();
      quote.push(line);
      continue;
    }
    if (LIST_RE.test(line)) {
      // 列表项：结束正文 / 引用 run，列表 run 连续收集
      flushText();
      flushQuote();
      list.push(line);
      continue;
    }
    if (list.length > 0 && LIST_CONT_RE.test(line)) {
      // 缩进续行归属列表项
      list.push(line);
      continue;
    }
    // 普通行（含空行）：结束引用 / 列表 run，进正文 run
    flushQuote();
    flushList();
    run.push(line);
  }
  flushAll();
  return parts;
}

/** 表格 → 容器树：table（带列对齐）→ 行（带表头标记）→ 单元格叶子 */
function tableTree(
  spec: { header: string[]; aligns: TableAlign[]; rows: string[][] },
  turn: number,
  step: number,
  source: Source,
  seqs: readonly number[] | undefined,
): LayoutBox {
  const rowBox = (cells: string[], header: boolean): LayoutBox => ({
    kind: "layout",
    turn,
    step,
    source,
    role: "row",
    ...(header ? { header: true } : {}),
    ...(seqs === undefined ? {} : { seqs }),
    children: cells.map((cell) => ({
      kind: "content",
      turn,
      step,
      source,
      shape: "cell" as const,
      text: cell,
      ...(seqs === undefined ? {} : { seqs }),
    })),
  });
  return {
    kind: "layout",
    turn,
    step,
    source,
    role: "table",
    aligns: spec.aligns,
    ...(seqs === undefined ? {} : { seqs }),
    children: [
      rowBox(spec.header, true),
      ...spec.rows.map((cells) => rowBox(cells, false)),
    ],
  };
}

/** 工具条目 → 一个叶子（整批） */
function toolBox(
  item: Item,
  turn: number,
  step: number,
): ContentBox | undefined {
  const calls = item.calls ?? [];
  const results = item.results ?? [];
  if (calls.length === 0 && results.length === 0) return undefined;
  return {
    kind: "content",
    turn,
    step,
    source: "tool",
    shape: "tool",
    batch: { calls, results },
    ...(item.seqs === undefined ? {} : { seqs: item.seqs }),
  };
}

/** box 缓存：键 = 节对象身份。封闭节对象不可变（迟到回写会换新对象）→ 可安全复用 */
const boxCache = new WeakMap<Section, LayoutBox[]>();

/** 节 → box 树（纯函数；第一级 = 类型块 LayoutBox，节内条目顺序即块顺序；按节缓存） */
export function buildBoxes(section: Section): LayoutBox[] {
  const hit = boxCache.get(section);
  if (hit !== undefined) return hit;
  const built = computeBoxes(section);
  boxCache.set(section, built);
  return built;
}

function computeBoxes(section: Section): LayoutBox[] {
  const markSteer = (blocks: LayoutBox[]): LayoutBox[] =>
    section.steer === true
      ? blocks.map((block) => ({
          ...block,
          steer: true,
          children: block.children.map((child) => ({ ...child, steer: true })),
        }))
      : blocks;
  const blocks: LayoutBox[] = [];
  let current: LayoutBox | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    blocks.push(current);
    current = undefined;
  };
  for (const item of section.items) {
    // 工具批 = 带 calls / results 的条目；来源为 tool 的**辅助行**（subagent / hook /
    // command 等）走文本分支，按普通行渲染
    const isBatch =
      item.source === "tool" &&
      (item.calls !== undefined || item.results !== undefined);
    const parts = isBatch
      ? [toolBox(item, section.turn, section.step)].filter(
          (box): box is ContentBox => box !== undefined,
        )
      : textParts(item, section.turn, section.step);
    if (parts.length === 0) continue;
    if (current === undefined || current.source !== item.source) {
      flush();
      current = {
        kind: "layout",
        turn: section.turn,
        step: section.step,
        source: item.source,
        role: "block",
        children: [],
      };
    }
    current = { ...current, children: [...current.children, ...parts] };
  }
  flush();
  return markSteer(blocks);
}

/** 该节点覆盖的事件号与 `shadowedSeqs` 是否有交集 */
function seqHit(node: Box, shadowedSeqs: ReadonlySet<number>): boolean {
  return (
    node.seqs !== undefined && node.seqs.some((seq) => shadowedSeqs.has(seq))
  );
}

/**
 * 压缩剪枝遮蔽标记：节点覆盖的事件号与 `shadowedSeqs` **有交集即整棵子树打标**
 * （宽无关；只在 box 层置位，颜色落第 4 步 / 渲染层）。容器命中 → 子树整标。
 */
export function applyShadowed<T extends Box>(
  blocks: readonly T[],
  shadowedSeqs: ReadonlySet<number>,
): readonly T[] {
  if (shadowedSeqs.size === 0) return blocks;
  let changed = false;
  const walk = (node: Box): Box => {
    const hit = seqHit(node, shadowedSeqs);
    if (node.kind === "layout") {
      const children = node.children.map(walk);
      const childChanged = children.some(
        (child, index) => child !== node.children[index],
      );
      if (!hit && !childChanged) return node;
      changed = true;
      return {
        ...node,
        ...(hit ? { shadowed: true } : {}),
        children,
      };
    }
    if (!hit && node.shadowed !== true) return node;
    if (node.shadowed === true) return node;
    changed = true;
    return { ...node, shadowed: true };
  };
  const next = blocks.map((node) => walk(node) as T);
  return changed ? next : blocks;
}
