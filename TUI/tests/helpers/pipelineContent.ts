// tests/helpers/pipelineContent.ts — 条目 16 段 C2 的测试内容构造器
//
// 背景：段 C2 之后 `state.local` 只承载 UI 本地行（notice / shell / tool / plain），
// 内容（用户块、正文、思考、工具批、step 头）**不再有缓冲行形态**，唯一来源是节缓存
// （`state.pipeline`，由交付驱动）。
//
// 本文件让测试用与旧 `reduceState({type:"append"|"user-line"|…})` 等价的**一行调用**造内容：
// 内部把等价交付 `applyDelivery` 进节缓存，再回写 `state.pipeline`。回合 / 步号缺省沿用
// 节缓存里的最近一次（没有则 1 / 1），与真实交付口径一致。
//
// 用法：
//   let s = initialState();
//   s = withTurnStart(s, 1);
//   s = withUser(s, "问题");
//   s = withText(s, "正文", "assistant");
//   s = withToolCall(s, "bash", "ls");
//   s = withToolResult(s, true, "ok");
//   s = withStep(s, 2);

import type { AppState } from "../../src/app/state.ts";
import { reduceState } from "../../src/app/state.ts";
import type { BlockDelivery } from "../../src/app/layout/pipeline/types.ts";
import {
  applyDelivery,
  createSections,
} from "../../src/app/layout/pipeline/sections.ts";

/** 把一条交付应用进 `state.pipeline`（缺省空节），返回新状态 */
export function withDelivery(
  state: AppState,
  delivery: BlockDelivery,
): AppState {
  const pipeline = applyDelivery(state.pipeline ?? createSections(), delivery);
  return reduceState(state, { type: "pipeline-state", pipeline });
}

/** 当前作用域（回合 / 步）：取节缓存最近一次，缺省 1 / 1（初值 `{turn:0,step:0}` 视为未设） */
function scopeOf(state: AppState): { turn: number; step: number } {
  const scope = state.pipeline?.lastScope;
  return {
    turn: scope !== undefined && scope.turn > 0 ? scope.turn : 1,
    step: scope !== undefined && scope.step > 0 ? scope.step : 1,
  };
}

/** `turn-start`（新回合开始；同时刷新作用域回合号） */
export function withTurnStart(state: AppState, turn?: number): AppState {
  const t = turn ?? scopeOf(state).turn + 1;
  return withDelivery(state, { kind: "turn-start", turn: t });
}

/** 用户块（同 `sendUserText` 的交付口径） */
export function withUser(
  state: AppState,
  text: string,
  turn?: number,
): AppState {
  const { turn: t, step } = scopeOf(state);
  return withDelivery(state, {
    kind: "user",
    turn: turn ?? t,
    step,
    text,
  });
}

/** 正文 / 思考行（`source: "reasoning"` = 思考） */
export function withText(
  state: AppState,
  text: string,
  source: "assistant" | "reasoning" = "assistant",
  index = 0,
): AppState {
  const { turn, step } = scopeOf(state);
  return withDelivery(state, { kind: "text", turn, step, index, source, text });
}

/** step 头（`╌╌ hh:mm:ss ⇆N #M`） */
export function withStep(
  state: AppState,
  step: number,
  time?: number,
): AppState {
  const { turn } = scopeOf(state);
  return withDelivery(state, {
    kind: "step-start",
    turn,
    step,
    ...(time === undefined ? {} : { time }),
  });
}

/** 工具调用行（`<name> <args>`，续行缩进走既有折行逻辑） */
export function withToolCall(
  state: AppState,
  name: string,
  args: string,
  callId = "c1",
): AppState {
  const { turn, step } = scopeOf(state);
  return withDelivery(state, {
    kind: "tool-call",
    turn,
    step,
    callId,
    name,
    args,
  });
}

/** 工具结果行（`✓ <detail>` / `✗ <detail>`） */
export function withToolResult(
  state: AppState,
  ok: boolean,
  detail: string,
  callId = "c1",
): AppState {
  const { turn, step } = scopeOf(state);
  return withDelivery(state, {
    kind: "tool-result",
    turn,
    step,
    callId,
    ok,
    detail,
  });
}

/** 回合结束（按 reason 给用户块打终态；缺省不传 reason = 保持未定） */
export function withTurnEnd(
  state: AppState,
  reason?:
    | "completed"
    | "aborted"
    | "error"
    | "blocked"
    | "max-tokens"
    | "interrupted",
): AppState {
  const { turn, step } = scopeOf(state);
  return withDelivery(state, {
    kind: "turn-end",
    turn,
    step,
    ...(reason === undefined ? {} : { reason }),
  });
}
