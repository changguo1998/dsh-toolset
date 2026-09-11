/**
 * 循环引擎纯核心：plateau 判定、方向比较、边界守卫、cadence 节流。
 *
 * 全部为纯函数（clock/measure 由调用方注入），可独立单测；
 * 持久化与 DSH 接入面在 persist.ts / index.ts，不在此。
 */

import type {
  AdvanceInput,
  AdvanceOutput,
  Direction,
  LoopState,
  LoopSpec,
  RoundRecord,
  StopReason,
  TickResult,
  WakeKind,
} from "./types.ts";

/** 默认 plateau 窗口（连续无改进轮数）。 */
export const DEFAULT_WINDOW = 5;
/** 默认轮数上限。 */
export const DEFAULT_MAX_ROUNDS = 50;

/** 严格改进判定：min 方向要求更小，max 方向要求更大；相等不算改进。 */
export function isBetter(
  value: number,
  best: number,
  direction: Direction,
): boolean {
  return direction === "min" ? value < best : value > best;
}

/** 归一化规格：补默认值并校验必填字段。 */
export function normalizeSpec(raw: LoopSpec): LoopState["spec"] {
  const direction: Direction = raw.direction ?? "min";
  if (direction !== "min" && direction !== "max") {
    throw new TypeError(
      `direction 必须为 min/max，收到：${String(raw.direction)}`,
    );
  }
  const window = raw.window ?? DEFAULT_WINDOW;
  const maxRounds = raw.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(window) || window < 1) {
    throw new RangeError(`window 必须为正整数，收到：${String(raw.window)}`);
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new RangeError(
      `maxRounds 必须为正整数，收到：${String(raw.maxRounds)}`,
    );
  }
  for (const key of ["timeBoundMs", "tokenBound", "cadenceSec"] as const) {
    const v = raw[key];
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
      throw new RangeError(`${key} 必须为非负有限数，收到：${String(v)}`);
    }
  }
  return {
    id: raw.id ?? "default",
    direction,
    window,
    maxRounds,
    ...(raw.measureCmd === undefined ? {} : { measureCmd: raw.measureCmd }),
    ...(raw.timeBoundMs === undefined ? {} : { timeBoundMs: raw.timeBoundMs }),
    ...(raw.tokenBound === undefined ? {} : { tokenBound: raw.tokenBound }),
    ...(raw.cadenceSec === undefined ? {} : { cadenceSec: raw.cadenceSec }),
  };
}

/** 创建初始状态（未开始：rounds=0，status=running）。 */
export function createInitialState(spec: LoopSpec, now: number): LoopState {
  return {
    id: spec.id ?? "default",
    spec: normalizeSpec(spec),
    createdAt: now,
    startedAt: 0,
    updatedAt: now,
    rounds: 0,
    best: null,
    streak: 0,
    tokensUsed: 0,
    lastSuccessAt: null,
    status: "running",
    stopReason: null,
    history: [],
  };
}

/** 规格是否带测量命令（空串视同无）。 */
export function hasMeasure(spec: LoopState["spec"]): boolean {
  return spec.measureCmd !== undefined && spec.measureCmd.trim() !== "";
}

/**
 * cadence 节流判定：auto 唤醒距上次成功不足 cadenceSec 时本轮跳过；
 * explicit 唤醒（显式 start/resume）为紧急唤醒，永不节流。
 */
export function shouldDefer(
  state: LoopState,
  now: number,
  wake: WakeKind,
): boolean {
  if (wake !== "auto" || state.status !== "running") return false;
  const waitMs = nextWakeMs(state, now);
  return waitMs > 0;
}

/** 下次自动唤醒允许的剩余等待（毫秒）；0 = 立即可唤醒。 */
export function nextWakeMs(state: LoopState, now: number): number {
  if (state.status !== "running") return 0;
  const cadenceSec = state.spec.cadenceSec;
  if (cadenceSec === undefined || cadenceSec <= 0) return 0;
  if (state.lastSuccessAt === null) return 0;
  const remaining = state.lastSuccessAt + cadenceSec * 1000 - now;
  return remaining > 0 ? remaining : 0;
}

/**
 * 单轮推进：
 * 1. 幂等守卫：已停止状态不再变化（控制器层同样守卫，双保险）；
 * 2. 轮前边界检查（maxRounds/time/tokens 已达 → 不跑本轮直接停止，round=null）；
 * 3. 执行本轮：测量值更新 best/streak（改进则 streak 归零；metricless 不判 plateau）；
 * 4. 轮后停止判定（优先级：plateau > maxRounds > time > tokens）。
 */
export function advance(input: AdvanceInput): AdvanceOutput {
  const { state, now, value, tokensUsed } = input;
  const spec = state.spec;

  // 幂等守卫：已停止状态不再推进
  if (state.status !== "running") {
    return { state, round: null, stopReason: null };
  }

  const roundNo = state.rounds + 1;

  // 轮前边界：已达上限则不消耗本轮直接停止（本轮未执行，round=null）
  const preStop = checkBounds(state, now);
  if (preStop !== null) {
    state.status = "stopped";
    state.stopReason = preStop;
    state.updatedAt = now;
    return { state, round: null, stopReason: preStop };
  }

  if (state.startedAt === 0) state.startedAt = now;

  // 执行本轮：按方向更新最优值与无改进连击（改进则 streak 归零）
  const measured = hasMeasure(spec);
  let roundValue: number | null = null;
  let improved = false;
  if (measured) {
    if (value === null) {
      // 测量失败 = 本轮无改进（streak+1），不更新 best
      state.streak += 1;
    } else {
      roundValue = value;
      if (state.best === null) {
        // 首值置基线，计为改进
        state.best = value;
        improved = true;
        state.streak = 0;
      } else if (isBetter(value, state.best, spec.direction)) {
        state.best = value;
        improved = true;
        state.streak = 0;
      } else {
        state.streak += 1;
      }
    }
  }

  const record: RoundRecord = {
    round: roundNo,
    value: roundValue,
    improved,
    at: now,
    tokensUsed,
  };
  state.rounds = roundNo;
  state.history.push(record);
  state.tokensUsed += tokensUsed;
  state.lastSuccessAt = now;
  state.updatedAt = now;

  // 轮后停止判定（优先级：plateau > maxRounds > time > tokens）
  let stopReason: StopReason | null = null;
  if (measured && state.streak >= spec.window) {
    stopReason = "plateau";
  } else {
    stopReason = checkBounds(state, now);
  }
  if (stopReason !== null) {
    state.status = "stopped";
    state.stopReason = stopReason;
  }
  return { state, round: record, stopReason };
}

/** 边界检查：maxRounds 优先，其次 time、tokens；未达返回 null。 */
export function checkBounds(state: LoopState, now: number): StopReason | null {
  const spec = state.spec;
  if (state.rounds >= spec.maxRounds) return "maxRounds";
  if (
    spec.timeBoundMs !== undefined &&
    state.startedAt > 0 &&
    now - state.startedAt >= spec.timeBoundMs
  ) {
    return "time";
  }
  if (spec.tokenBound !== undefined && state.tokensUsed >= spec.tokenBound) {
    return "tokens";
  }
  return null;
}

/**
 * 供模型直接调用的宿主 schedule 参数（复用宿主 schedule 面做自动唤醒）；
 * 已停止返回 null。after 一次性提醒链式续排，便于逐轮控制与及时停止。
 */
export function scheduleHint(
  state: LoopState,
  now: number,
): TickResult["schedule"] {
  if (state.status !== "running") return null;
  const afterSeconds = Math.max(1, Math.ceil(nextWakeMs(state, now) / 1000));
  return {
    tool: "schedule_create",
    args: {
      after_seconds: afterSeconds,
      prompt: `[metric-loop] 自动唤醒：调用 metric_loop tick（wake=auto，id=${state.id}）继续指标循环`,
    },
  };
}

/** 生成 TickResult 摘要行（now 供 deferred 场景精确计算剩余等待）。 */
export function summarize(result: {
  deferred: boolean;
  round: RoundRecord | null;
  state: LoopState;
  now?: number;
}): string {
  const { state } = result;
  if (result.deferred) {
    const remaining = nextWakeMs(state, result.now ?? state.updatedAt);
    return `loop ${state.id}：cadence 未到，本轮跳过（${Math.ceil(
      remaining / 1000,
    )}s 后可自动唤醒）`;
  }
  if (state.status === "stopped") {
    const roundPart = result.round
      ? `第 ${result.round.round} 轮 ${describeRound(result.round)}`
      : "（本轮未执行）";
    return `loop ${state.id} 已停止（${state.stopReason}）：${roundPart}，共 ${state.rounds} 轮${describeBest(state)}`;
  }
  const roundPart = result.round
    ? `第 ${result.round.round} 轮 ${describeRound(result.round)}`
    : "";
  return `loop ${state.id} 运行中：${roundPart}，共 ${state.rounds}/${state.spec.maxRounds} 轮${describeBest(state)}，streak ${state.streak}/${state.spec.window}`;
}

/** 轮记录描述（内部辅助）。 */
function describeRound(round: RoundRecord): string {
  const valuePart =
    round.value === null ? "测量失败/无指标" : `value=${round.value}`;
  const improvePart = round.improved ? "改进" : "无改进";
  return `${valuePart}（${improvePart}）`;
}

/** 最优值描述（内部辅助）。 */
function describeBest(state: LoopState): string {
  if (state.best === null) return "";
  return `，best=${state.best}`;
}
