/**
 * 指标驱动自动循环的类型定义。
 *
 * 语义对齐 metric-loop/TASK.md：
 * - direction: min（越低越好）/ max（越高越好）
 * - window: 连续 N 轮无改进 → plateau 停止（默认 5）
 * - 边界: 轮数 cap（默认 50）、时间 bound（可选）、token bound（可选）
 * - cadence: 成功后自动唤醒的最小间隔（秒）；显式 start/resume 为紧急唤醒，不受 cadence 限制
 * - metricless（无测量命令）: 只按边界停止，不做 plateau 判定
 */

/** 指标方向：min 越低越好，max 越高越好。 */
export type Direction = "min" | "max";

/** 停止原因。 */
export type StopReason = "plateau" | "maxRounds" | "time" | "tokens" | "manual";

/** 循环状态。 */
export type LoopStatus = "running" | "stopped";

/** 唤醒来源：auto = 宿主 schedule 周期唤醒；explicit = 用户显式 start/resume（紧急，不受 cadence 限制）。 */
export type WakeKind = "auto" | "explicit";

/** 一次循环的规格（用户配置）。 */
export interface LoopSpec {
  /** 循环标识（缺省 'default'），用于定位状态文件。 */
  id?: string;
  /** 测量命令（输出单个数字）；缺省/空串 = metricless（无指标，只按边界停止）。 */
  measureCmd?: string;
  /** 指标方向，缺省 'min'。 */
  direction?: Direction;
  /** plateau 窗口：连续无改进轮数，缺省 5。 */
  window?: number;
  /** 轮数上限（cap），缺省 50。 */
  maxRounds?: number;
  /** 时间边界（毫秒，自第一轮起），可选。 */
  timeBoundMs?: number;
  /** token 边界（累计），可选。 */
  tokenBound?: number;
  /** 成功后自动唤醒最小间隔（秒），可选。 */
  cadenceSec?: number;
}

/** 单轮记录。 */
export interface RoundRecord {
  /** 轮次，从 1 起。 */
  round: number;
  /** 测量值；metricless 或测量失败时为 null。 */
  value: number | null;
  /** 本轮是否改进（首值置基线计为改进）。 */
  improved: boolean;
  /** 本轮完成时刻（毫秒时钟）。 */
  at: number;
  /** 本轮消耗的 token（由宿主/模型报告，缺省 0）。 */
  tokensUsed: number;
}

/** 循环持久化状态。 */
export interface LoopState {
  /** 循环标识。 */
  id: string;
  /** 归一化后的规格。 */
  spec: Required<Pick<LoopSpec, "direction" | "window" | "maxRounds">> &
    LoopSpec;
  /** 创建时刻。 */
  createdAt: number;
  /** 第一轮时刻（未开始为 0）。 */
  startedAt: number;
  /** 最近更新时刻。 */
  updatedAt: number;
  /** 已完成轮数。 */
  rounds: number;
  /** 历史最优值（metricless 恒 null）。 */
  best: number | null;
  /** 连续无改进轮数。 */
  streak: number;
  /** 累计 token。 */
  tokensUsed: number;
  /** 最近一轮完成时刻（cadence 基准）。 */
  lastSuccessAt: number | null;
  /** 状态。 */
  status: LoopStatus;
  /** 停止原因（running 时 null）。 */
  stopReason: StopReason | null;
  /** 轮次历史（追加式）。 */
  history: RoundRecord[];
}

/** 推进单轮的输入。 */
export interface AdvanceInput {
  state: LoopState;
  now: number;
  /** 测量值；null = metricless 或测量失败。 */
  value: number | null;
  /** 存在测量命令但未解析出数字。 */
  measureFailed: boolean;
  tokensUsed: number;
}

/** 推进单轮的结果。 */
export interface AdvanceOutput {
  state: LoopState;
  round: RoundRecord | null;
  stopReason: StopReason | null;
}

/** start/tick 的统一返回。 */
export interface TickResult {
  /** true = cadence 未满足，本轮跳过（auto 唤醒被节流）。 */
  deferred: boolean;
  /** 本轮记录；deferred 或已停止时为 null。 */
  round: RoundRecord | null;
  /** 最新状态。 */
  state: LoopState;
  /** 建议的下次自动唤醒延迟（秒）；已停止为 0。 */
  nextWakeSec: number;
  /** 供模型直接调用的宿主 schedule 参数；已停止为 null。 */
  schedule: {
    tool: "schedule_create";
    args: { after_seconds: number; prompt: string };
  } | null;
  /** 供 agent 阅读的一句话摘要。 */
  summary: string;
}
