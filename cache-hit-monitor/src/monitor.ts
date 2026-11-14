/**
 * cache-hit-monitor 判定核心（纯函数, 可脱离宿主单测）。
 *
 * per-session 状态机：请求前（`agent/pre-step`）按上次/本次快照前缀重叠度粗估可命中率,
 * 请求后（`assistant/message.usage`）算实际命中率, 偏差超阈值判缓存失效（stale）。
 * 状态位实时维护「从回合开始到当前的运行最低」对应状态, 不回退不抖动。
 *
 * 口径（追踪文档决策 6/7/10/11）：
 * - 实时全程：每步都算预估与实际、都得出状态（不是只在第一步; 「只盯第一步」为可选开关）。
 * - 首次（无上次快照）：命中率按 0, 状态 first（黄）, 不参与偏差判定（无预估基线）,
 *   作运行最低起点。
 * - 无 usage 数据：保持该步预估状态?——否, 决策 11: 无 cache 数据时状态行保持 `—`
 *   不着色（那是渲染层职责）; 判定层只维护「上次真实命中率」供运行最低刷新。
 * - 运行最低：本回合各步**有实际命中率**的最小值对应状态; 首次 0 作起点,
 *   收到首个真实 usage 后由真实值接管（否则长期停黄）。收到真实 usage 的步才可能刷新下限。
 */

import { actualHitRate, estimateHitRate, prefixOverlap } from "./overlap.ts";

/** 一次请求前取到的完整上下文快照（`deriveMessages()` 的结果, 只读）。 */
export type ContextSnapshot = readonly unknown[];

/** 判定状态（服务面与渲染层共享的三态; 渲染层另行负责「无数据占位」）。 */
export type CacheJudgment = "normal" | "stale" | "first";

/** 针对某一步的采集摘要（供服务面 summary 读取）。 */
export interface StepOutcome {
  /** 该步的判定状态。 */
  state: CacheJudgment;
  /** 预估命中率（首次/无基线时为 undefined）。 */
  estimated: number | undefined;
  /** 实际命中率（无 usage 时为 undefined）。 */
  actual: number | undefined;
  /** 预警阈值（配置, 用于渲染可回显偏差）。 */
  tolerance: number;
}

/** 会话级监控状态。 */
export interface MonitorState {
  /** 上次请求前快照（前缀比对基准; 无 = 首次请求）。 */
  lastSnapshot: ContextSnapshot | undefined;
  /** 本次请求前快照（等 usage 到达时结算后提升为 last）。 */
  pendingSnapshot: ContextSnapshot | undefined;
  /** 本回合运行最低实际命中率（首次 0 作起点, 首个真实 usage 接管; 无真实数据 = undefined）。 */
  runMinActual: number | undefined;
  /** runMinActual 是否已被真实 usage 接管（false = 仍是首次的合成基线 0）。 */
  runMinReal: boolean;
  /** 最近一步的采集摘要（供 summary; 无数据时 undefined）。 */
  lastOutcome: StepOutcome | undefined;
  /** 是否已判定过第一步（用于「只盯第一步」开关）。 */
  firstSeen: boolean;
}

/** 新建一个会话的监控状态。 */
export function createMonitorState(): MonitorState {
  return {
    lastSnapshot: undefined,
    pendingSnapshot: undefined,
    runMinActual: undefined,
    runMinReal: false,
    lastOutcome: undefined,
    firstSeen: false,
  };
}

/** 记录本次请求前快照（挂到 pending; 结算时由 endStep 提升为 last）。 */
export function recordSnapshot(
  states: Map<string, MonitorState>,
  sessionId: string,
  snapshot: ContextSnapshot,
): MonitorState {
  let state = states.get(sessionId);
  if (state === undefined) {
    state = createMonitorState();
    states.set(sessionId, state);
  }
  state.pendingSnapshot = snapshot;
  return state;
}

/** 取某会话状态; `undefined` = 尚无任何活动。 */
export function stateOf(
  states: Map<string, MonitorState>,
  sessionId: string,
): MonitorState | undefined {
  return states.get(sessionId);
}

/** 会话销毁时清理状态, 返回是否真有该会话。 */
export function dropState(
  states: Map<string, MonitorState>,
  sessionId: string,
): boolean {
  return states.delete(sessionId);
}

/** 判定一步的采集与结算参数（usage 到达时调用）。 */
export interface JudgeParams {
  tolerance: number;
  /** 可选「只盯第一步」: true 时第一步之后不再更新状态位（挂起, 不再刷新）。 */
  firstStepOnly: boolean;
}

/**
 * 一步收尾结算（usage 到达后调用）:
 * - 从 pending 提升 last（供下一步前缀比对）;
 * - 若无上次快照 → 首次: 命中率按 0, 状态 first, 不参与偏差判定, runMin 起点 0;
 * - 否则: 预估 = pending 与 last 的前缀重叠度, 实际 = 传入的 cacheRead/cacheRatio,
 *   偏差 |实际 − 预估| > tolerance → stale, 否则 normal;
 * - 实际有值（cache 数据齐全）时才可能刷新 runMin（决策 10: 真实值接管）;
 * - 只盯第一步: firstSeen 之后不再改 lastOutcome（保持第一步快照, 不再刷新）。
 */
export function endStep(
  state: MonitorState,
  opts: {
    tolerance: number;
    firstStepOnly: boolean;
    cacheRead?: number;
    input?: number;
    /** 传实际命中率则跳过内部换算（测试友好; 缺省走 cacheRead/input）。 */
    actualRatio?: number;
  },
): StepOutcome {
  const current = state.pendingSnapshot;
  const last = state.lastSnapshot;
  // 无论后续如何, pending 提升为 last（下一步的前缀基准）。
  const prevLast = last;
  state.lastSnapshot = current;
  state.pendingSnapshot = undefined;

  const actualOverride = opts.actualRatio;
  const hasActual =
    actualOverride !== undefined ||
    (opts.cacheRead !== undefined && opts.input !== undefined);
  const actual =
    actualOverride !== undefined
      ? actualOverride
      : hasActual
        ? actualHitRate(opts.cacheRead ?? 0, opts.input ?? 0)
        : undefined;

  let outcome: StepOutcome;
  if (prevLast === undefined || current === undefined) {
    // 首次（无上次快照）: 状态 first（黄）, 豁免偏差判定（决策 7）。
    // 有真实 usage 时 actual 仍记录（供显示与运行最低接管）; 预估无基线 → undefined。
    outcome = {
      state: "first",
      estimated: undefined,
      actual,
      tolerance: opts.tolerance,
    };
    // 运行最低起点: 首次 0。真实 usage 到达且实际有值时, 由真实值接管（决策 10:
    // 首次 0 只在没有真实数据前作占位基线, 首个真实 usage 接管, 避免长期停黄）。
    if (state.runMinActual === undefined) {
      if (hasActual && actual !== undefined) {
        state.runMinActual = actual;
        state.runMinReal = true;
      } else {
        state.runMinActual = 0;
        state.runMinReal = false;
      }
    } else if (!state.runMinReal && hasActual && actual !== undefined) {
      state.runMinActual = actual;
      state.runMinReal = true;
    }
  } else {
    const overlap = prefixOverlap(prevLast, current);
    const estimated = estimateHitRate(overlap, current.length);
    const deviation =
      actual === undefined ? undefined : Math.abs(actual - estimated);
    const stale = deviation !== undefined && deviation > opts.tolerance;
    outcome = {
      state: stale ? "stale" : "normal",
      estimated,
      actual,
      tolerance: opts.tolerance,
    };
    // 只有真实 usage 才刷新 runMin; 尚未被真实值接管时, 由首个真实值接管。
    if (actual !== undefined) {
      if (state.runMinReal) {
        state.runMinActual = Math.min(state.runMinActual ?? actual, actual);
      } else {
        state.runMinActual = actual;
        state.runMinReal = true;
      }
    }
  }

  if (!opts.firstStepOnly || !state.firstSeen) {
    state.lastOutcome = outcome;
  }
  state.firstSeen = true;
  return outcome;
}

/** 运行最低判定状态（按 runMinActual: first 尚未有真实值 → first; 否则按阈值对比某基线）。
 *  此函数主要供 summary 层把「运行最低命中率」映射回三态（渲染层用）。 */
export function judgmentOfRunMin(
  runMinActual: number | undefined,
  tolerance: number,
): CacheJudgment {
  if (runMinActual === undefined) return "first";
  // 运行最低本身不与某次预估比——它保存的是「最差一次实际命中率」;
  // 三态决定仍以最近一步的偏差判定为准（渲染层读 lastOutcome.state）。
  // 这里仅表达「有真实数据且非 first」的语义, 供 summary 展示数值。
  return runMinActual > tolerance ? "normal" : "stale";
}
