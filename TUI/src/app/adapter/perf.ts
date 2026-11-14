// TUI/src/app/adapter/perf.ts — 单步性能读数（纯函数）
//
// 口径见 docs/archived/2026-11-14-tui-model-performance.md「追加修改」：
// 首字节延时 = 首块时刻 − 本 step 起点（实际测量）；解码速率 = 本步已产出内容的估算
// token ÷ 首块后时长（真实 usage 收尾才到，而收尾即归零，故实时只能给估算值）。

/** 实时性能投递的最小间隔（ms）：状态行按 ticker/合帧重绘，投递过密没有视觉收益。 */
export const LIVE_PERF_MIN_MS = 250;

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
}

/** 本 step 当前读数：首块未到 → undefined（无读数）；不足一个节流窗口 → 速率记 0。 */
export function perfReadingOf(
  perf: StepPerf,
  now: number,
): { ttfbMs: number; avgTokensPerSec: number } | undefined {
  const first = perf.firstChunkTime;
  if (first === undefined) return undefined;
  const durMs = now - first;
  const est = perf.estTokens ?? 0;
  return {
    ttfbMs: perf.start === undefined ? 0 : Math.max(0, first - perf.start),
    avgTokensPerSec:
      durMs >= LIVE_PERF_MIN_MS && est > 0 ? (est / durMs) * 1000 : 0,
  };
}
