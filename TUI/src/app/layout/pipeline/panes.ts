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
  /**
   * 已声明的 step（`SectionsState.stepMeta` 的键，**按到达顺序**）：step 头按此发放——
   * 与旧口径一致（旧路径在 step/start 就画头，即使该 step 暂无内容）。
   */
  declaredSteps?: readonly string[];
  /** step 的时间戳（`SectionsState.stepMeta`）：暂无内容的 step 画头时取这里的时间 */
  stepTimes?: ReadonlyMap<string, { time?: number }>;
  /** 回合开始时间（`SectionsState.turnMeta`）：回合分隔线的时间真源 */
  turnTimes?: ReadonlyMap<string, number>;
  /**
   * 首 pane 内容前的回合分隔线（旧口径：turn-begin 即画线，含第一回合）。
   * 渐进窗口丢过内容时为 false——窗口起点在回合中间，旧路径已把该线切掉。
   */
  leadingSeparator?: boolean;
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
  options: PaneOptions,
): void {
  const previous = acc.last;
  if (previous !== undefined) {
    if (previous.turn !== box.turn) {
      if (withSeparators) {
        const time =
          options.turnTimes?.get(String(box.turn)) ??
          meta.get("turn:" + box.turn);
        acc.items.push({
          kind: "turn-separator",
          turn: box.turn,
          ...(time === undefined ? {} : { time }),
        });
      }
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
  // 未显式给 declaredSteps（直接调用 / 单测）时，按节序列自造声明表（每有内容的节一个 step）
  const declared =
    options.declaredSteps ??
    (() => {
      const keys: string[] = [];
      for (const section of sections) {
        if (section.items.length === 0) continue;
        const key = stepKey(section.turn, section.step);
        if (keys[keys.length - 1] !== key) keys.push(key);
      }
      return keys;
    })();
  const declaredAt = new Map(declared.map((key, index) => [key, index]));

  // 窗口起点之前被丢的 step 不发头（否则丢掉的更早 step 会在回合区末尾复活）
  const firstKept = sections.find((section) => section.items.length > 0);
  let declaredDone =
    firstKept === undefined
      ? 0
      : (declaredAt.get(stepKey(firstKept.turn, firstKept.step)) ?? 0);
  /** 补发 declared 队列里到 `until`（含）为止尚未发的 step 头 */
  const headUpTo = (until: number): void => {
    for (
      let index = declaredDone;
      index <= until && index < declared.length;
      index++
    ) {
      const key = declared[index]!;
      declaredDone = index + 1;
      if (headed.has(key)) continue;
      if (options.suppressFirstHead === true && !headedOnce) {
        headedOnce = true;
        continue;
      }
      headedOnce = true;
      headed.add(key);
      const [turn, step] = key.split(":");
      const time = meta.get(key) ?? options.stepTimes?.get(key)?.time;
      activity.items.push({
        kind: "step-head",
        turn: Number(turn),
        step: Number(step),
        ...(time === undefined ? {} : { time }),
      });
    }
  };
  for (const section of sections) {
    const boxes = applyShadowed(buildBoxes(section), shadowed);
    if (boxes.length === 0) continue;
    // step 头（旧口径：step 头是工具行，恒进回合区；该 step 无回合区内容时是「孤儿头」；
    // 旧路径在 step/start 即画头 ⇒ 本层按 declaredSteps 顺序补发，含暂无内容的最新 step）
    headUpTo(
      declaredAt.get(stepKey(section.turn, section.step)) ?? declaredDone,
    );
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
        push(target, line, meta, target === dialogue, options);
      }
    }
  }
  // 尾部：已声明但暂无内容的 step（如刚落地的 step/start）也要画头（旧口径同步可见）
  headUpTo(declared.length - 1);
  // 首内容前的回合分隔线：旧口径由 turn-begin 画线（首回合空历史不画）——流水线同判据，
  // 以「该回合被 turn-start 交付过」（turnTimes 命中，含重放器按分隔线行的补交付）为准；
  // 内容存在本身不再推断分隔线（否则首回合空历史的提交会多出一条旧路径没有的线）。
  // 窗口丢过内容时已切掉不再补（leadingSeparator=false）。
  const firstDeclared = declared[0];
  if (options.leadingSeparator !== false && firstDeclared !== undefined) {
    const turn = Number(firstDeclared.split(":")[0]);
    if (options.turnTimes?.has(String(turn)) === true) {
      const time =
        options.turnTimes?.get(String(turn)) ?? meta.get("turn:" + turn);
      dialogue.items.unshift({
        kind: "turn-separator",
        turn,
        ...(time === undefined ? {} : { time }),
      });
    }
  }
  return { dialogue: dialogue.items, activity: activity.items };
}
