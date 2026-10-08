// src/app/layout/pipeline/panes.ts — 第 3 步「显示准备」：box → pane 缓存 ×2（**宽无关**）
//
// 五步（追踪文档「pane 构建（box 缓存 → pane 缓存）」）：
//   ① 档位过滤（活动区 `think` / `tool` / `step`，追加时跳过 box）
//   ② 替换符号（只作用于文本；代码 / 表格 / 工具参数不替换）
//   ③ 拆行（文本 box → 逻辑行；**代码块与表格不拆**）
//   ④ 加边界（step 变化 → step 头；turn 变化 → 回合分隔线；分类变化 → 空行）
//   ⑤ 合并空行（连续空行并成 1 个；代码块内不合并）
//
// 归属：`user` 与**带 `final` 的节**里正文 → 会话区；`reasoning` / 工具批 / 非 final 正文 /
// notice → 回合区。宽度相关（折行、紧凑截断、竖线连通）一律留给第 4 步；边界项的**文案**
// （`hh:mm:ss #N` / `╌╌ hh:mm:ss ⇆N ╌╌`）也在第 4 步渲染，本层只给位置与元数据。

import type { ActivityLevel } from "../../state.ts";
import { applyShadowed, buildBoxes, type Box } from "./boxes.ts";
import { stepKey, type Section } from "./types.ts";

/** pane 项：逻辑行 box 或边界项 */
export type PaneItem =
  | { readonly kind: "line"; readonly box: Box }
  | { readonly kind: "blank" }
  | {
      readonly kind: "step-head";
      readonly turn: number;
      readonly step: number;
      readonly time?: number;
    }
  | {
      readonly kind: "turn-separator";
      readonly turn: number;
      readonly time?: number;
    };

/** pane 缓存（会话区 / 回合区） */
export interface PaneCache {
  readonly dialogue: readonly PaneItem[];
  readonly activity: readonly PaneItem[];
}

export interface PaneOptions {
  /** 活动区档位（`/verbose think|tool|step`）：think = 全量；tool = 去思考；step = 只留工具调用 */
  level: ActivityLevel;
  /** 符号替换（`symbol-normalizer` 服务；缺省原文透传）。只作用于文本，代码 / 表格不替换 */
  normalize?: (text: string) => string;
  /** 压缩剪枝遮蔽的宿主事件号（box 层按交集打灰） */
  shadowedSeqs?: ReadonlySet<number>;
}

/** 档位过滤：该 box 在活动区是否可见（会话区不受档位影响） */
function visibleAtLevel(box: Box, level: ActivityLevel): boolean {
  if (level === "think") return true;
  if (box.source === "reasoning") return false;
  if (level === "tool") return true;
  // step：只留工具调用（notice 保留，供提示可见）
  return box.source === "tool" || box.source === "notice";
}

/** 归属：会话区 = 用户块 + final 节的正文；其余进回合区 */
function isDialogue(box: Box, final: boolean): boolean {
  if (box.source === "user") return true;
  return final && box.source === "assistant" && box.shape === "text";
}

/** 氛围分类：相邻 box 分类不同 → 空行（来源 × 结构各一档：正文 / 代码 / 表格 / 工具 / 思考…） */
function mood(box: Box): string {
  return box.source + ":" + box.shape;
}

/** 拆行：文本 box → 逻辑行 box；代码 / 表格 / 工具批不拆 */
function toLines(
  box: Box,
  normalize: ((text: string) => string) | undefined,
): readonly Box[] {
  if (box.shape !== "text") return [box];
  const text =
    normalize === undefined ? (box.text ?? "") : normalize(box.text ?? "");
  return text.split("\n").map((line) => ({ ...box, text: line }));
}

interface Acc {
  items: PaneItem[];
  last?: Box;
  /** 待插入的 step 头（scope 变化时置位，下一行落地前插） */
  pendingHead?: { turn: number; step: number };
}

function blank(acc: Acc): void {
  const tail = acc.items[acc.items.length - 1];
  if (tail !== undefined && tail.kind !== "blank")
    acc.items.push({ kind: "blank" });
}

/** 追加一个逻辑行 box：必要时先插边界项（step 头 / 回合分隔线 / 空行） */
function push(
  acc: Acc,
  box: Box,
  meta: ReadonlyMap<string, number | undefined>,
  withHeads: boolean,
): void {
  const previous = acc.last;
  if (previous === undefined) {
    // 首项：活动区给 step 头（思考 / 工具归属到某个 step），会话区不插
    if (withHeads) acc.pendingHead = { turn: box.turn, step: box.step };
  } else if (previous.turn !== box.turn || previous.step !== box.step) {
    if (previous.turn !== box.turn) {
      acc.items.push({
        kind: "turn-separator",
        turn: box.turn,
        ...(meta.get("turn:" + box.turn) === undefined
          ? {}
          : { time: meta.get("turn:" + box.turn) }),
      });
    }
    if (withHeads) acc.pendingHead = { turn: box.turn, step: box.step };
  } else if (mood(previous) !== mood(box)) {
    blank(acc);
  }
  if (acc.pendingHead !== undefined) {
    const head = acc.pendingHead;
    acc.items.push({
      kind: "step-head",
      turn: head.turn,
      step: head.step,
      ...(meta.get(stepKey(head.turn, head.step)) === undefined
        ? {}
        : { time: meta.get(stepKey(head.turn, head.step)) }),
    });
    acc.pendingHead = undefined;
  }
  acc.items.push({ kind: "line", box });
  acc.last = box;
}

/** 按 pane 归属把 box 分派进两条缓存（顺序 = 节顺序 + box 顺序） */
export function buildPanes(
  sections: readonly Section[],
  options: PaneOptions,
): PaneCache {
  const meta = new Map<string, number | undefined>();
  for (const section of sections) {
    meta.set(stepKey(section.turn, section.step), section.time);
    if (!meta.has("turn:" + section.turn)) {
      meta.set("turn:" + section.turn, section.time);
    }
  }
  const dialogue: Acc = { items: [] };
  const activity: Acc = { items: [] };
  const shadowed = options.shadowedSeqs ?? new Set<number>();
  for (const section of sections) {
    const boxes = applyShadowed(buildBoxes(section), shadowed);
    for (const box of boxes) {
      for (const line of toLines(box, options.normalize)) {
        const target = isDialogue(line, section.final === true)
          ? dialogue
          : visibleAtLevel(line, options.level)
            ? activity
            : undefined;
        if (target === undefined) continue;
        // 空文本行 = 空行（第 ⑤ 步：连续空行并成 1 个；代码块不拆故不受影响）
        if (line.shape === "text" && (line.text ?? "") === "") {
          blank(target);
          continue;
        }
        push(target, line, meta, target === activity);
      }
    }
  }
  return { dialogue: dialogue.items, activity: activity.items };
}
