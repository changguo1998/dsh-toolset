// src/app/layout/pipeline/route.ts — §3 分流：EventGroup[] → { session, turn } PaneItem[]
//
// 职责（追踪文档 T23-T26）：把每个模型交互（EventGroup）的解析块按来源分派到
// 会话区（正文 / 用户块 / step 概要）与回合区（思考 / 工具 / 非 final 正文），
// 并以显式 `Gap` 表达所有留白（空行唯一来源）。规则全部取自 `routeTable.ts` 的数据表：
//  - 来源 × 终态 → pane / 类别（`ruleFor`）；
//  - 回合区「思考 ↔ 正文」间隔（`turnBlankBetween`）；会话区「user → 正文」间隔；
//  - step 头（内容驱动、只对已声明 step）/ 回合分隔线（turn-start 交付）在此定位。

import type { ActivitySwitches } from "../../state.ts";
import { stepKey } from "./types.ts";
import { categoryVisible, ruleFor, turnBlankBetween } from "./routeTable.ts";
import type {
  EventGroup,
  Gap,
  PaneItem,
  StepHeader,
  ToolBatch,
  TurnHeader,
} from "./ir.ts";

/** 回合区「思考 ↔ 正文」间隔判定档 */
type GapKind = "think" | "reply";

export interface RouteOptions {
  /** 活动区显示档位（/verbose think|tool|reply）：按类别决定该类内容是否进回合区 */
  activityShow?: Partial<ActivitySwitches>;
  /** 活动区压缩档位（/collapse think|tool|reply）：结构层按它压单行（本层只透传） */
  activityCompact?: Partial<ActivitySwitches>;
  /** 符号替换（symbol-normalizer 服务；缺省原文透传） */
  normalize?: (text: string) => string;
  /** 压缩剪枝遮蔽的宿主事件号（按 EventGroup 交集打灰，结构层消费） */
  shadowedSeqs?: ReadonlySet<number>;
  /** 抑制首个内容节的 step 头（渐进窗口起点落在节中间时） */
  suppressFirstHead?: boolean;
  /** 已声明的 step（`SectionsState.stepMeta` 键，按到达顺序）：step 头按此发放 */
  declaredSteps?: readonly string[];
  /** step 时间戳（`SectionsState.stepMeta`）：暂无内容的 step 画头时取这里的时间 */
  stepTimes?: ReadonlyMap<string, { time?: number }>;
  /** 回合开始时间（`SectionsState.turnMeta`）：回合分隔线的时间真源 */
  turnTimes?: ReadonlyMap<string, number | undefined>;
}

/** EventGroup 的终态（final / history 交互 → 正文与工具批归会话区） */
function finalOf(group: EventGroup): boolean {
  const p = group.provenance;
  return p.final === true || p.history === true;
}

/** 遮蔽块 id：组的宿主事件号与 `shadowedSeqs` 有交集 → 该组全部块打灰 */
export function shadowedBlockIds(
  groups: readonly EventGroup[],
  shadowedSeqs?: ReadonlySet<number>,
): Set<string> {
  const out = new Set<string>();
  if (shadowedSeqs === undefined || shadowedSeqs.size === 0) return out;
  for (const group of groups) {
    if (!group.provenance.seqs.some((seq) => shadowedSeqs.has(seq))) continue;
    for (const block of group.blocks) out.add(block.id);
  }
  return out;
}

/**
 * §3 分流主入口：EventGroup[] → 两 pane 扁平 PaneItem[]（对话一路，追加）。
 * chrome 五 pane（tool / statusBar / statusCol / titleBar / input）是独立刷新路，
 * 不在此函数内。
 */
export function route(
  groups: readonly EventGroup[],
  options: RouteOptions = {},
): { session: PaneItem[]; turn: PaneItem[] } {
  const session: PaneItem[] = [];
  const turn: PaneItem[] = [];
  const show = options.activityShow ?? {};
  // 回合区「思考 ↔ 正文」间隔记账
  let lastGapKind: GapKind | "tool" | undefined;
  // 会话区 user → 正文 间隔记账（只看上一条是否 user 块）
  let lastSessionUser = false;
  // step 头记账（内容驱动、每 step 一次）
  const headed = new Set<string>();
  let headedOnce = false;
  const declaredSet = new Set(options.declaredSteps ?? []);

  /** step 头：内容驱动——在该 step 的第一条回合区内容前画（仅已声明 step） */
  const ensureHead = (turnNo: number, step: number): void => {
    const key = stepKey(turnNo, step);
    if (!declaredSet.has(key) || headed.has(key)) return;
    if (options.suppressFirstHead === true && !headedOnce) {
      headedOnce = true;
      headed.add(key);
      return;
    }
    headedOnce = true;
    headed.add(key);
    const time = options.stepTimes?.get(key)?.time;
    turn.push({
      kind: "step-header",
      key: "step@" + key,
      turn: turnNo,
      step,
      ...(time === undefined ? {} : { time }),
    } satisfies StepHeader);
  };

  // 回合分隔线来自 turn-start 交付（turnTimes 时间真源）；与内容按 turn 号交错，
  // 尾部剩余追加到末尾。窗口起点之前的回合线随内容一起没有（见 `firstTurn` 守卫）。
  const emittedTurns = new Set<number>();
  const firstTurn = groups.find((g) => g.blocks.length > 0)?.provenance.turn;
  const pushSeparator = (n: number): void => {
    if (emittedTurns.has(n)) return;
    emittedTurns.add(n);
    if (firstTurn !== undefined && n < firstTurn) return;
    const time = options.turnTimes?.get(String(n));
    session.push({
      kind: "turn-header",
      key: "sep@" + n,
      turn: n,
      ...(time === undefined ? { untitled: true } : { time }),
    } satisfies TurnHeader);
  };
  const markedTurns = [...(options.turnTimes?.keys() ?? [])]
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  let markerAt = 0;
  const emitMarkersUpTo = (n: number): void => {
    while (markerAt < markedTurns.length && markedTurns[markerAt]! <= n) {
      pushSeparator(markedTurns[markerAt]!);
      markerAt += 1;
    }
  };

  for (const group of groups) {
    const p = group.provenance;
    emitMarkersUpTo(p.turn);
    const final = finalOf(group);
    for (const block of group.blocks) {
      const rule = ruleFor(block.source, final);
      if (rule.pane === "session") {
        // steer 插队送达的用户块：与上一条输入之间留白
        if (block.source === "user" && p.steer === true) {
          session.push({ kind: "gap", key: "blank@" + block.id } satisfies Gap);
        }
        // 会话区 user → 正文（assistant）之间留 1 行（旧 `spaceUserAssistant`）
        if (lastSessionUser && block.source === "assistant") {
          session.push({ kind: "gap", key: "blank@" + block.id } satisfies Gap);
        }
        session.push(block);
        lastSessionUser = block.source === "user";
        continue;
      }
      // 回合区：档位过滤
      if (!categoryVisible(rule.category, rule.constant, show)) continue;
      ensureHead(p.turn, p.step);
      // 「思考 ↔ 正文」间隔（工具 / 恒显不参与；工具把上一档重置）
      const gapKind = rule.gapKind;
      if (
        turnBlankBetween(lastGapKind as GapKind, gapKind) &&
        turn.length > 0
      ) {
        turn.push({ kind: "gap", key: "blank@" + block.id } satisfies Gap);
      }
      if (rule.category === "tool") lastGapKind = "tool";
      else if (gapKind !== undefined) lastGapKind = gapKind;
      turn.push(block);
    }
    // 工具批（结构化显示，route 组合成 ToolBatch）：工具不插空行、重置上一档
    const calls = group.calls ?? [];
    const results = group.results ?? [];
    if (
      (calls.length > 0 || results.length > 0) &&
      categoryVisible("tool", false, show)
    ) {
      ensureHead(p.turn, p.step);
      lastGapKind = "tool";
      turn.push({
        kind: "tool-batch",
        key: p.id + ":calls",
        calls,
        results,
      } satisfies ToolBatch);
    }
  }
  // 尾部剩余的分隔线（已交付 turn-start 但该回合还没有任何内容）
  emitMarkersUpTo(Number.POSITIVE_INFINITY);
  return { session, turn };
}
