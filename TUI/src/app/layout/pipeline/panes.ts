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

/** 节身份（稳定段键前缀）：节对象在一次会话内不因窗口 / 宽度变化而重建，故 WeakMap 发号即可 */
const sectionIds = new WeakMap<object, number>();
let nextSectionId = 0;

function sectionId(section: Section): number {
  const hit = sectionIds.get(section);
  if (hit !== undefined) return hit;
  nextSectionId += 1;
  sectionIds.set(section, nextSectionId);
  return nextSectionId;
}

/**
 * pane 项：逻辑行 box 或边界项。
 * `key` = **稳定段键**（滚动定位 / 重映射用）：节身份 + 节内 box 序号；窗口扩缩、
 * 宽度变化、行数变化都不变，故「视口顶内容」可以靠它跨帧与跨重排保持。
 */
export type PaneItem =
  | {
      readonly kind: "line";
      readonly box: Box;
      readonly key: string;
      /** 活跃用户块（批 B1）：终态未定的最后一条用户输入 → 行层带 `active`，符号不回查 buffer */
      readonly active?: boolean;
    }
  | { readonly kind: "blank"; readonly key: string }
  | {
      readonly kind: "step-summary";
      readonly text: string;
      readonly key: string;
    }
  | {
      readonly kind: "step-head";
      readonly turn: number;
      readonly step: number;
      readonly time?: number;
      readonly key: string;
    }
  | {
      readonly kind: "turn-separator";
      readonly turn: number;
      readonly time?: number;
      /** 无标签（时间未知）：画纯虚线，不写 `hh:mm:ss ⇆N`（旧路径同款） */
      readonly untitled?: boolean;
      readonly key: string;
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
  /** 回合开始时间（`SectionsState.turnMeta`）：回合分隔线的时间真源；`undefined` = 时间未知（纯虚线） */
  turnTimes?: ReadonlyMap<string, number | undefined>;
  /**
   * 首 pane 内容前的回合分隔线（旧口径：turn-begin 即画线，含第一回合）。
   * 渐进窗口丢过内容时为 false——窗口起点在回合中间，旧路径已把该线切掉。
   */
  leadingSeparator?: boolean;
}

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
 * 归属：会话区 = 用户块 + **final 节的 assistant 内容（正文 / 引用 / 列表 / 代码块 / 表格都算）**；
 * 其余（思考 / 工具批 / 非 final 正文 / notice）进回合区。
 * 注意：final 节里的代码块与表格仍是该回合的最终答复（旧路径同口径），不能按结构分流。
 */
function isDialogue(box: Box, final: boolean): boolean {
  if (box.source === "user") return true;
  return final && box.source === "assistant";
}

/**
 * 回合区的「活动类型」三档（旧渲染器 `ActKind` 同口径）：思考 / 正文 / 工具。
 * 只有思考 ↔ 正文之间留空行；**工具会把上一档重置成 tool**（故「思考 → 工具 → 正文」
 * 不留白）——notice / shell / 用户块不参与，也不重置。
 */
type ActKind = "reasoning" | "assistant" | "tool";

function actKind(box: Box): ActKind | undefined {
  if (box.kind === "content" && box.shape === "tool") return "tool";
  if (box.source === "reasoning") return "reasoning";
  if (box.source === "assistant") return "assistant";
  return undefined;
}

/**
 * 文本类叶子（text / quote / list）在此层**不按行拆**：整段交给第 4 步按物理行展开
 * （boxToLines），同一节正文的行才落在同一次排版调用里——「块内空行竖线连排」等
 * 逐叶子后处理才看得到邻居（拆散后每行孤立成调用，空行丢失竖线上下文）。
 * 符号替换（normalize）在整段文本上应用；代码 / 表格 / 工具批原样透传。
 */
function toLines(
  box: Box,
  normalize: ((text: string) => string) | undefined,
): readonly Box[] {
  const textual =
    box.kind === "content" &&
    (box.shape === "text" || box.shape === "quote" || box.shape === "list");
  if (!textual || normalize === undefined) return [box];
  return [{ ...box, text: normalize(box.text ?? "") }];
}

interface Acc {
  items: PaneItem[];
  last?: Box;
  /** 上一档活动类型（回合区留白判据；见 `actKind`） */
  lastActKind?: ActKind;
  /** 本 pane 是否会话区（会话区的留白规则不同：user → 正文） */
  dialogue: boolean;
}

/**
 * 吸收空 notice：紧接工具批 / step 头之前的「空文本 notice 段」不渲染（旧渲染器
 * `absorbActivityBlank` 在工具 run 边界上的连续 pop 口径）。
 */
function absorbEmptyNotice(acc: Acc): void {
  const tail = acc.items[acc.items.length - 1];
  if (tail === undefined || tail.kind !== "line") return;
  const box = tail.box;
  if (box.kind !== "content" || box.source !== "notice") return;
  if ((box.text ?? "").replace(/\n+$/, "") !== "") return;
  acc.items.pop();
}

function blank(acc: Acc, key: string): void {
  const tail = acc.items[acc.items.length - 1];
  if (tail !== undefined && tail.kind !== "blank")
    acc.items.push({ kind: "blank", key: "blank@" + key });
}

/**
 * 追加一个逻辑行 box：必要时先插边界项。
 *  - `withSeparators`（仅会话区）：turn 变化 → 回合分隔线（旧口径：分隔线是会话区的线）；
 *  - 会话区留白：用户块之后接正文（旧渲染器 `spaceUserAssistant`）；
 *  - 回合区留白：思考 ↔ 正文（旧渲染器 `noteActKind`；工具重置上一档）。
 * step 头由调用方按 step 预置（旧口径：step 头是工具行，恒进回合区）。
 */
function push(
  acc: Acc,
  box: Box,
  key: string,
  meta: ReadonlyMap<string, number | undefined>,
  withSeparators: boolean,
  options: PaneOptions,
): void {
  const previous = acc.last;
  const kind = actKind(box);
  // 留白判定要在更新 lastActKind **之前**算（并在本函数内统一更新）
  const pairBlank =
    !acc.dialogue &&
    kind !== undefined &&
    kind !== "tool" &&
    acc.lastActKind !== undefined &&
    acc.lastActKind !== "tool" &&
    acc.lastActKind !== kind;
  if (kind !== undefined) acc.lastActKind = kind;
  const userBlank =
    acc.dialogue &&
    previous !== undefined &&
    previous.source === "user" &&
    box.source === "assistant";
  if (pairBlank || userBlank) blank(acc, key);
  if (box.kind === "content" && box.shape === "tool") absorbEmptyNotice(acc);
  acc.items.push({ kind: "line", box, key });
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
  const dialogue: Acc = { items: [], dialogue: true };
  const activity: Acc = { items: [], dialogue: false };
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
      absorbEmptyNotice(activity);
      activity.items.push({
        key: "step@" + key,
        kind: "step-head",
        turn: Number(turn),
        step: Number(step),
        ...(time === undefined ? {} : { time }),
      });
    }
  };
  // 回合分隔线来自 **`turn-start` 交付**（App 在 turn-begin 即交付：分隔线先到、首个 token
  // 后到）——与旧路径「turn-begin 往缓冲追加 `separator` 行」同口径；已交付但暂无内容的
  // 回合（刚落地 turn-begin / 被中断）同样画线。按 turn 号与节交错，尾部剩余的追加到末尾。
  const markedTurns = [...(options.turnTimes?.keys() ?? [])]
    .map(Number)
    .filter((turn) => Number.isFinite(turn))
    .sort((a, b) => a - b);
  // 窗口保留的是**整回合组**（前几组整体丢弃）：被丢回合的线随内容一起没有，
  // 窗口内各回合的线照画（旧路径的 separator 行就落在组的开头）
  const firstTurn = sections.find(
    (section) => section.items.length > 0 || section.stepSummary !== undefined,
  )?.turn;
  let markerAt = 0;
  const emittedTurns = new Set<number>();
  /** 画一条回合分隔线（同一回合只画一次；被窗口丢掉的回合不画） */
  const pushSeparator = (turn: number): void => {
    if (emittedTurns.has(turn)) return;
    emittedTurns.add(turn);
    if (firstTurn !== undefined && turn < firstTurn) return;
    const time =
      options.turnTimes?.get(String(turn)) ?? meta.get("turn:" + turn);
    dialogue.items.push({
      kind: "turn-separator",
      turn,
      key: "sep@" + turn,
      // 时间未知（本地 turn-begin 刚落、宿主尚未回填）→ 画纯虚线：旧路径
      // `turnHeaderLine(undefined, undefined)` = 无标签，标签只随时间一起出现
      ...(time === undefined ? { untitled: true } : { time }),
    });
  };
  const emitMarkersUpTo = (turn: number): void => {
    while (markerAt < markedTurns.length && markedTurns[markerAt]! <= turn) {
      pushSeparator(markedTurns[markerAt]!);
      markerAt += 1;
    }
  };
  for (const section of sections) {
    emitMarkersUpTo(section.turn);
    // P9 恢复会话的 step 概要行：先于该节内容落进会话区（无条目也照样出这一行）
    if (section.stepSummary !== undefined) {
      dialogue.items.push({
        kind: "step-summary",
        text: section.stepSummary,
        key: "summary@" + sectionId(section),
      });
    }
    const blocks = applyShadowed(buildBoxes(section), shadowed);
    if (blocks.length === 0) continue;
    // step 头（旧口径：step 头是工具行，恒进回合区；该 step 无回合区内容时是「孤儿头」；
    // 旧路径在 step/start 即画头 ⇒ 本层按 declaredSteps 顺序补发，含暂无内容的最新 step）
    // **未声明的 step**（没有 step/start 交付，如恢复前的裸工具行）不提前冲刷已声明的头：
    // 旧路径的头是随 step 事件追加在末尾的，提前画会把头排到那些行之前（顺序反了）
    const declaredAt2 = declaredAt.get(stepKey(section.turn, section.step));
    if (declaredAt2 !== undefined) headUpTo(declaredAt2);
    // 段键：节身份 + 节内 box 序号（跨窗口扩缩、宽度变化都稳定）
    const sid = sectionId(section);
    let ordinal = 0;
    for (const block of blocks) {
      for (const part of block.children) {
        const bkey = sid + ":" + ordinal++;
        for (const line of toLines(part, options.normalize)) {
          const target = isDialogue(line, section.final === true)
            ? dialogue
            : visibleAtLevel(line, options.level)
              ? activity
              : undefined;
          if (target === undefined) continue;
          // 空文本行进 pane（**不自造空行项**）：交回既有渲染器按旧口径裁剪/吸收
          // （前导与尾部空行裁掉、notice 的纯换行吸收）——自造空行会绕过这些规则
          // steer 插队送达：与上一条输入之间留白（旧口径 `markSteerClaim` 的可见效果）
          if (line.source === "user" && line.steer === true)
            blank(target, bkey);
          push(target, line, bkey, meta, target === dialogue, options);
        }
      }
    }
  }
  // 尾部：已声明但暂无内容的 step（如刚落地的 step/start）也要画头（旧口径同步可见）
  headUpTo(declared.length - 1);
  // 尾部剩余的分隔线（已交付 turn-start 但该回合还没有任何内容）
  emitMarkersUpTo(Number.POSITIVE_INFINITY);
  // 活跃用户块（批 B1）：会话区**最后一条**终态未定、也未被 steer 续接的用户输入 →
  // 行层带 `active`，符号解析按它判「运行 ●/○ / 等待 △」，不必再回查 buffer
  for (let i = dialogue.items.length - 1; i >= 0; i--) {
    const item = dialogue.items[i]!;
    if (item.kind !== "line" || item.box.source !== "user") continue;
    if (item.box.userStatus === undefined && item.box.steerContinued !== true) {
      dialogue.items[i] = { ...item, active: true };
    }
    break;
  }
  return { dialogue: dialogue.items, activity: activity.items };
}
