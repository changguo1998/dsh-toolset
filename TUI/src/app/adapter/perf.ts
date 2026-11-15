// TUI/src/app/adapter/perf.ts — 单步性能读数（纯函数）
//
// 口径见 docs/archived/2026-11-14-tui-model-performance.md「追加修改」与
// docs/archived/2026-11-15-tui-perf-display-cadence.md：
// 首字节延时 = 首块时刻 − 本 step 起点（实际测量）；解码速率 = 本步已产出内容的估算
// token 按 **1s 窗口采样**——上一采样以来的 Δtoken ÷ Δ时间。计算随每条 chunk 快速
// 累积（estTokens 照旧），投递与统计节流到 1s（计算与显示分离）。

/** 实时性能投递的最小间隔（ms）：状态行按 ticker/合帧重绘，投递过密没有视觉收益。
 *  2026-11-15 起 = 1000：计算随每条 chunk 快速累积，显示/统计每秒一次。 */
export const LIVE_PERF_MIN_MS = 1000;

/** 本 step 的性能采集状态（`AdapterContext.stepPerf` 的条目） */
export interface StepPerf {
  /** step/start 时刻（TTFB 起点） */
  start?: number;
  /** 首个输出块到达时刻（TTFB 终点；未到达则没有读数） */
  firstChunkTime?: number;
  /** 本步已产出内容的估算 token 累计（正文 + 思考 + 工具调用参数与结果） */
  estTokens?: number;
  /** 上次实时投递时刻（节流用） */
  lastPerfEmit?: number;
  /** 上次速率采样点：时刻 + 当时累计 token（1s 窗口速率 = Δtoken ÷ Δ时间） */
  lastSampleAt?: number;
  lastSampleTokens?: number;
}

/** 本 step 当前读数：首块未到 → undefined（无读数）；速率 = 上一采样以来的
 *  Δtoken ÷ Δ时间（首块首次投递无上一采样 → 记 0，不足 1s 数据如实显示）。 */
export function perfReadingOf(
  perf: StepPerf,
  now: number,
): { ttfbMs: number; avgTokensPerSec: number } | undefined {
  const first = perf.firstChunkTime;
  if (first === undefined) return undefined;
  const est = perf.estTokens ?? 0;
  const rate =
    perf.lastSampleAt !== undefined && perf.lastSampleTokens !== undefined
      ? ((est - perf.lastSampleTokens) / (now - perf.lastSampleAt)) * 1000
      : 0;
  return {
    ttfbMs: perf.start === undefined ? 0 : Math.max(0, first - perf.start),
    avgTokensPerSec: est > 0 ? Math.max(0, rate) : 0,
  };
}
