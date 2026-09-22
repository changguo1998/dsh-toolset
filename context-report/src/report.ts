// src/report.ts — 报告渲染（纯函数：状态 + 即时读数 → 结构化报告 + 文本）
//
// `formatCount` 用 k/M 简写长数字（报告面向人读）；`occupancyPct` 只在已知容量时给出，
// 容量缺省时明确写「容量未知」而非猜分母。文本与结构化字段同源，避免两处口径漂移。

import type {
  ContextBreakdownLike,
  ContextOccupancy,
  ContextPressureLike,
  ContextReport,
  ContextReportInput,
  ReportDetail,
  SessionContextState,
  TokenBuckets,
} from "./types.ts";
import { createInitialState } from "./fold.ts";

const DETAILS: readonly ReportDetail[] = ["summary", "standard", "full"];

/** 归一细节级别（非法值回落 standard）。 */
export function normalizeDetail(value: unknown): ReportDetail {
  return typeof value === "string" &&
    (DETAILS as readonly string[]).includes(value)
    ? (value as ReportDetail)
    : "standard";
}

/** 千分位计数的紧凑写法（>= 1e6 用 M，>= 1e3 用 k，保留一位小数）。 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 墙钟毫秒的紧凑写法（>= 60s 用 m+s）。 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m${seconds}s`;
  }
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** 占用百分比（容量未知时 undefined）。 */
export function occupancyOf(
  pressure: ContextPressureLike | undefined,
  fallbackWindow: number | undefined,
): ContextOccupancy {
  const pressureTokens =
    pressure?.pressureTokens !== undefined && pressure.pressureTokens > 0
      ? pressure.pressureTokens
      : undefined;
  const projectedTokens =
    pressure?.projectedTokens !== undefined && pressure.projectedTokens > 0
      ? pressure.projectedTokens
      : undefined;
  const contextWindow =
    pressure?.contextWindow !== undefined && pressure.contextWindow > 0
      ? pressure.contextWindow
      : fallbackWindow !== undefined && fallbackWindow > 0
        ? fallbackWindow
        : undefined;
  const numerator = projectedTokens ?? pressureTokens;
  const occupancyPct =
    contextWindow !== undefined && numerator !== undefined
      ? Math.round((numerator / contextWindow) * 1000) / 10
      : undefined;
  return {
    ...(projectedTokens !== undefined ? { projectedTokens } : {}),
    ...(pressureTokens !== undefined ? { pressureTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(occupancyPct !== undefined ? { occupancyPct } : {}),
  };
}

/** token 分桶累计（含总量）。 */
export function tokenBuckets(state: SessionContextState): TokenBuckets {
  const uncachedInput = state.uncachedInputTokens;
  const output = state.outputTokens;
  return {
    uncachedInput,
    output,
    cacheRead: state.cacheReadTokens,
    cacheWrite: state.cacheWriteTokens,
    reasoning: state.reasoningTokens,
    total:
      uncachedInput + output + state.cacheReadTokens + state.cacheWriteTokens,
  };
}

/** 渲染报告（文本与结构化字段同源）。 */
export function buildReport(input: ContextReportInput): ContextReport {
  const state = input.state;
  const detail = input.detail ?? "standard";
  const generatedAt =
    input.generatedAt ?? (Number.isFinite(Date.now()) ? Date.now() : 0);
  const tokens = tokenBuckets(state ?? createInitialState());
  const occupancy = occupancyOf(input.pressure, undefined);
  const route: { provider: string; model: string } | undefined =
    state?.provider !== undefined && state?.model !== undefined
      ? { provider: state.provider, model: state.model }
      : undefined;
  const durations =
    state === undefined
      ? undefined
      : {
          llmMs: state.llmMs,
          toolMs: state.toolMs,
          ttftMs: state.ttftMs,
          decodeMs: state.decodeMs,
        };
  const report: ContextReport = {
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    generatedAt,
    detail,
    projection: state === undefined ? "unavailable" : "sessionContext",
    asOfSeq: state?.asOfSeq ?? -1,
    turns: state?.turns ?? 0,
    steps: state?.steps ?? 0,
    tokens,
    occupancy,
    ...(detail !== "summary" && durations !== undefined ? { durations } : {}),
    ...(detail === "full" && input.breakdown !== undefined
      ? { breakdown: input.breakdown }
      : {}),
    ...(detail !== "summary" && route !== undefined ? { route } : {}),
    text: "",
  };
  return { ...report, text: renderText(report) };
}

/** 文本渲染：按级别给出不同深度的表格化数字。 */
export function renderText(report: ContextReport): string {
  const lines: string[] = [];
  const head =
    report.sessionId !== undefined
      ? `会话 ${report.sessionId}`
      : "会话（未知 id）";
  lines.push(`${head} 上下文报告（${report.detail}）`);
  if (report.projection === "unavailable") {
    lines.push("- 会话累计：不可用（sessionContext 投影未注册）");
  } else {
    lines.push(
      `- 回合/步：${report.turns} / ${report.steps}（已关闭步，水位 seq=${report.asOfSeq}）`,
    );
  }
  lines.push(
    `- token 累计：总 ${formatCount(report.tokens.total)} = 未缓存输入 ${formatCount(report.tokens.uncachedInput)} + 缓存读 ${formatCount(report.tokens.cacheRead)} + 缓存写 ${formatCount(report.tokens.cacheWrite)} + 输出 ${formatCount(report.tokens.output)}`,
  );
  if (report.detail !== "summary") {
    const o = report.occupancy;
    const windowText =
      o.contextWindow !== undefined ? formatCount(o.contextWindow) : "容量未知";
    const pctText =
      o.occupancyPct !== undefined ? `（${o.occupancyPct}%）` : "";
    const projectedText =
      o.projectedTokens !== undefined
        ? `下次请求预估 ${formatCount(o.projectedTokens)}`
        : o.pressureTokens !== undefined
          ? `最近上报 ${formatCount(o.pressureTokens)}`
          : "无压力采样";
    lines.push(`- 上下文占用：${projectedText} / ${windowText}${pctText}`);
    const d = report.durations;
    if (d !== undefined) {
      const ttftAvg =
        report.steps > 0 && d.ttftMs > 0 ? d.ttftMs / report.steps : 0;
      const decodeRate =
        d.decodeMs > 0 && report.tokens.output > 0
          ? (report.tokens.output / (d.decodeMs / 1000)).toFixed(1)
          : undefined;
      lines.push(
        `- 墙钟累计：模型 ${formatMs(d.llmMs)}、工具 ${formatMs(d.toolMs)}、首 token ${formatMs(d.ttftMs)}（均 ${formatMs(ttftAvg)}）、解码 ${formatMs(d.decodeMs)}`,
      );
      if (decodeRate !== undefined)
        lines.push(`- 解码速率：约 ${decodeRate} tok/s`);
    }
  }
  if (report.detail === "full") {
    lines.push(
      `- token 细分：reasoning ${formatCount(report.tokens.reasoning)}（输出的子集，不重复计入总量）`,
    );
    if (report.route !== undefined) {
      lines.push(`- 最近路由：${report.route.provider}/${report.route.model}`);
    }
    const b = report.breakdown;
    if (b !== undefined) {
      lines.push(
        `- 下次请求构成（启发式）：system ${formatCount(b.systemTokens)}、tools ${formatCount(b.toolsTokens)}、messages ${formatCount(b.messageTokens)}`,
      );
    } else {
      lines.push("- 下次请求构成：未接入（需组合宿主 contextBreakdown 投影）");
    }
  }
  if (report.route !== undefined && report.detail === "standard") {
    lines.push(`- 最近路由：${report.route.provider}/${report.route.model}`);
  }
  if (report.projection === "unavailable") {
    lines.push(
      "- 提示：数据缺失不等于 0；宿主未装配 session-projection 时请勿据此判断用量",
    );
  }
  return lines.join("\n");
}

/**
 * 归一报告输入的缺省值（细节级别），并可补入外部来源的上下文构成。
 * @param input - 调用方给的原始输入。
 * @param breakdown - 外部上下文构成（当前宿主无公开读面，调用方传 undefined）。
 * @returns 归一后的输入。
 */
export function withDefaults(
  input: ContextReportInput,
  breakdown: ContextBreakdownLike | undefined,
): ContextReportInput {
  const detail = normalizeDetail(input.detail);
  return input.breakdown === undefined && breakdown !== undefined
    ? { ...input, detail, breakdown }
    : { ...input, detail };
}
