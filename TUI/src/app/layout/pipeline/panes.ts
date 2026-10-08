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
  /** 抑制首个内容节的 step 头（渐进窗口起点落在节中间时，旧路径已把该头切掉） */
  suppressFirstHead?: boolean;
  /** 已声明的 step（`SectionsState.stepMeta` 的键）：未声明不发头（如恢复时首个内容之前） */
  declaredSteps?: ReadonlySet<string>;
}

/** 拆行缓存：键 = box 身份（box 由节缓存给出、稳定）——行缓存据此保持身份 */
const lineCache = new WeakMap<Box, readonly Box[]>();

/**
 * 档位过滤：该 box 在活动区是否可见（会话区不受档位影响）。
 * 口径与旧渲染器一致：`tool` / `step` 去思考；工具批内部的**结果行**由第 4 步沿用
 * 旧渲染器按档位裁掉（调用行只取首行），故此处不拆工具批。
 */
function visibleAtLevel(box: Box, level: ActivityLevel): boolean {
  if (level === "think") return true;
  return box.source !== "reasoning";
}

/**
 * 归属：会话区 = 用户块 + **final 节的 assistant 内容（正文 / 代码块 / 表格都算）**；
 * 其余（思考 / 工具批 / 非 final 正文 / notice）进回合区。
 * 注意：final 节里的代码块与表格仍是该回合的最终答复（旧路径同口径），不能按结构分流。
 */
function isDialogue(box: Box, final: boolean): boolean {
  if (box.source === "user") return true;
  return final && box.source === "assistant";
}

/**
 * 氛围分类：相邻 box 分类不同 → 空行。按**来源**分档（正文 / 代码 / 表格同属 assistant：
 * 旧口径同块内不插空行，空行只来自 markdown 原文的空行）；工具批与思考各成一档。
 */
function mood(box: Box): string {
  return box.shape === "tool" ? "tool" : box.source;
}

/** 拆行：文本 box → 逻辑行 box；代码 / 表格 / 工具批不拆 */
function toLines(
  box: Box,
  normalize: ((text: string) => string) | undefined,
): readonly Box[] {
  if (box.shape !== "text") return [box];
  if (normalize === undefined) {
    const hit = lineCache.get(box);
    if (hit !== undefined) return hit;
    const built = (box.text ?? "")
      .split("\n")
      .map((line) => ({ ...box, text: line }));
    lineCache.set(box, built);
    return built;
  }
  const text = normalize(box.text ?? "");
  return text.split("\n").map((line) => ({ ...box, text: line }));
}

interface Acc {
  items: PaneItem[];
  last?: Box;
}

function blank(acc: Acc): void {
  const tail = acc.items[acc.items.length - 1];
  if (tail !== undefined && tail.kind !== "blank")
    acc.items.push({ kind: "blank" });
}

/**
 * 追加一个逻辑行 box：必要时先插边界项。
 *  - `withSeparators`（仅会话区）：turn 变化 → 回合分隔线（旧口径：分隔线是会话区的线）；
 *  - 分类变化 → 空行（相邻 box 的来源 × 结构不同）。
 * step 头由调用方按 step 预置（旧口径：step 头是工具行，恒进回合区）。
 */
function push(
  acc: Acc,
  box: Box,
  meta: ReadonlyMap<string, number | undefined>,
  withSeparators: boolean,
): void {
  const previous = acc.last;
  if (previous !== undefined) {
    if (previous.turn !== box.turn && withSeparators) {
      const time = meta.get("turn:" + box.turn);
      acc.items.push({
        kind: "turn-separator",
        turn: box.turn,
        ...(time === undefined ? {} : { time }),
      });
    } else if (mood(previous) !== mood(box)) {
      blank(acc);
    }
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
    // 只补不覆盖：独立自足节（用户 / notice）时间缺失，别把它当该 step / 回合的时间
    const key = stepKey(section.turn, section.step);
    if (section.time !== undefined && meta.get(key) === undefined) {
      meta.set(key, section.time);
    }
    const turnKey = "turn:" + section.turn;
    if (section.time !== undefined && meta.get(turnKey) === undefined) {
      meta.set(turnKey, section.time);
    }
  }
  const dialogue: Acc = { items: [] };
  const activity: Acc = { items: [] };
  const shadowed = options.shadowedSeqs ?? new Set<number>();
  const headed = new Set<string>();
  let headedOnce = false;
  for (const section of sections) {
    const boxes = applyShadowed(buildBoxes(section), shadowed);
    if (boxes.length === 0) continue;
    // step 头（旧口径：step 头是工具行，恒进回合区；该 step 无回合区内容时是「孤儿头」）。
    // 独立自足节（用户 / notice / shell）没有 step 头；窗口起点落在节中间时首个头已被切掉。
    const key = stepKey(section.turn, section.step);
    const suppress = options.suppressFirstHead === true && !headedOnce;
    headedOnce = true;
    // 头按 scope 发放（notice / 用户节继承最近 scope ⇒ 同一 step 只发一次；旧路径在
    // step/start 处发头，故不因「该节内容进了会话区」而跳过）
    const declared =
      options.declaredSteps === undefined || options.declaredSteps.has(key);
    if (declared && !headed.has(key) && !suppress) {
      headed.add(key);
      const stepTime = meta.get(key);
      activity.items.push({
        kind: "step-head",
        turn: section.turn,
        step: section.step,
        ...(stepTime === undefined ? {} : { time: stepTime }),
      });
    }
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
        push(target, line, meta, target === dialogue);
      }
    }
  }
  return { dialogue: dialogue.items, activity: activity.items };
}
