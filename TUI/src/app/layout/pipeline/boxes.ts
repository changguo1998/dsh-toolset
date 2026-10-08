// src/app/layout/pipeline/boxes.ts — 第 2 步「结构」：节 → box 序列（**宽无关**）
//
// 口径（追踪文档「节 → box（宽无关）」）：
//   - 粒度：一个节 → 一个有序 box 序列，按结构边界拆（正文 / 代码块 / 表格 / 工具批）；
//   - 结构识别在这一层：围栏配对（未闭合只吃到本条目文本末尾）、表格识别（复用
//     `layout/table.ts` 的解析）、工具批 = 整批一个 box；
//   - **不插任何分隔内容**（空行 / step 头 / 回合分隔线由第 3 步按相邻 box 推导）；
//   - 宽度相关（代码折行、行号列、表格列宽、紧凑截断）一律留给第 4 步。
//
// 与旧路径的差异（有意）：围栏配对只看本条目文本，不看其他行——旧实现「未闭合 ⇒ 跳到
// 窗口末尾」会丢掉其后全部内容（BACKLOG 缺陷条目 / R7），新口径结构上不可能发生。

import { isTableStart, parseTableAt, type TableSpec } from "../table.ts";
import type { Item, Section, Source } from "./types.ts";

/** box 结构类别 */
export type Shape = "text" | "code" | "table" | "tool";

/** 代码块（宽无关：只有语言标记与原文行；行号列 / 折行在第 4 步） */
export interface CodeBox {
  lang: string;
  lines: string[];
  /** 围栏是否闭合（未闭合 = 条目文本用尽；仍是普通代码块，不吞后续内容） */
  closed: boolean;
}

/** 工具批：调用 1..N + 结果 1..N 合成一个 box（内部保留各条 callId / name / args / 状态） */
export interface ToolBatch {
  calls: NonNullable<Item["calls"]>;
  results: NonNullable<Item["results"]>;
}

/** 结构 box（宽无关） */
export interface Box {
  turn: number;
  step: number;
  source: Source;
  shape: Shape;
  /** 文本类原文（text 类；未拆行、未替换符号） */
  text?: string;
  code?: CodeBox;
  table?: TableSpec;
  batch?: ToolBatch;
  /** notice 分级（来源条目的 tone 透传） */
  tone?: Item["tone"];
  /** 该 box 覆盖的宿主事件号（来自条目账；压缩剪枝遮蔽判定用） */
  seqs?: readonly number[];
  /** 压缩剪枝遮蔽（`compaction/prune`）：整块渲染成灰，内容与行数不变 */
  shadowed?: boolean;
}

/** 围栏开关行（与旧路径同一正则口径：最多 3 空格缩进 + 3 个以上反引号 / 波浪号 + 可选语言） */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w.+-]*)[ \t]*$/;

/** 该行是否为围栏开关行；命中返回语言标记 */
function fenceLang(line: string): string | undefined {
  const match = FENCE_RE.exec(line);
  return match === null ? undefined : (match[2] ?? "");
}

/** 文本条目 → box 序列：正文 / 代码块 / 表格逐段拆 */
function textBoxes(item: Item, turn: number, step: number): Box[] {
  const text = item.text ?? "";
  if (text === "") return [];
  const lines = text.split("\n");
  const boxes: Box[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    boxes.push({
      turn,
      step,
      source: item.source,
      shape: "text",
      text: run.join("\n"),
      ...(item.tone === undefined ? {} : { tone: item.tone }),
      ...(item.seqs === undefined ? {} : { seqs: item.seqs }),
    });
    run = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lang = fenceLang(line);
    if (lang !== undefined) {
      // 围栏开启：向后收集代码行，直到同类闭合围栏（不足 3 个 / 不同字符不算）
      flush();
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
      boxes.push({
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
        flush();
        boxes.push({
          turn,
          step,
          source: item.source,
          shape: "table",
          table: parsed.table,
          ...(item.seqs === undefined ? {} : { seqs: item.seqs }),
        });
        i = parsed.end - 1;
        continue;
      }
    }
    run.push(line);
  }
  flush();
  return boxes;
}

/** 工具条目 → 一个 box（整批） */
function toolBox(item: Item, turn: number, step: number): Box | undefined {
  const calls = item.calls ?? [];
  const results = item.results ?? [];
  if (calls.length === 0 && results.length === 0) return undefined;
  return {
    turn,
    step,
    source: "tool",
    shape: "tool",
    batch: { calls, results },
    ...(item.seqs === undefined ? {} : { seqs: item.seqs }),
  };
}

/** box 缓存：键 = 节对象身份。封闭节对象不可变（迟到回写会换新对象）→ 可安全复用 */
const boxCache = new WeakMap<Section, Box[]>();

/** 节 → box 序列（纯函数；节内条目顺序即 box 顺序；按节缓存） */
export function buildBoxes(section: Section): Box[] {
  const hit = boxCache.get(section);
  if (hit !== undefined) return hit;
  const built = computeBoxes(section);
  boxCache.set(section, built);
  return built;
}

function computeBoxes(section: Section): Box[] {
  const boxes: Box[] = [];
  for (const item of section.items) {
    if (item.source === "tool") {
      const box = toolBox(item, section.turn, section.step);
      if (box !== undefined) boxes.push(box);
      continue;
    }
    boxes.push(...textBoxes(item, section.turn, section.step));
  }
  return boxes;
}

/**
 * 压缩剪枝遮蔽标记：box 覆盖的事件号与 `shadowedSeqs` **有交集即整块打标**
 * （宽无关；只在 box 层置位，颜色落第 4 步 / 渲染层）。
 */
export function applyShadowed(
  boxes: readonly Box[],
  shadowedSeqs: ReadonlySet<number>,
): readonly Box[] {
  if (shadowedSeqs.size === 0) return boxes;
  let changed = false;
  const next = boxes.map((box) => {
    if (box.seqs === undefined || box.seqs.length === 0) return box;
    if (!box.seqs.some((seq) => shadowedSeqs.has(seq))) return box;
    changed = true;
    return { ...box, shadowed: true };
  });
  return changed ? next : boxes;
}

/** 多节 → box 序列（顺序 = 节顺序；各节内部按 `buildBoxes`） */
export function buildAllBoxes(sections: readonly Section[]): Box[] {
  const boxes: Box[] = [];
  for (const section of sections) boxes.push(...buildBoxes(section));
  return boxes;
}
