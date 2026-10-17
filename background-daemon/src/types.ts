/**
 * 后台守护的公共类型（任务、流水、渠道契约）。
 *
 * 设计依据：`docs/implementation/2026-10-15-background-daemon-design.md`。
 * 本包只做结构面访问宿主服务（不 import 宿主类型）, 因此这些类型是**本包自己的**契约,
 * 与宿主的 `Agent` / `CommandRuntime` 之间用最小结构子集对接。
 */

import type { Selector } from "./selectors.ts";

/** 投递消息的来源标识（TUI 按 `source.kind` 识别并渲染成用户块）。 */
export const SOURCE_KIND = "background-daemon";

/**
 * 任务分档（2026-10-17 裁定：S / P / U 三档）。
 * 首期三档只作为记录标签与作用域键（`S` = 会话级、`P` = 项目级、`U` = 用户级）,
 * 与 memory-base 的作用域对接留待其配套改动落地（见设计 §H）。
 */
export type TaskTier = "S" | "P" | "U";

/** 任务类型：投递提示文本 / 执行 slash 命令（语义分开, 不互相降级）。 */
export type TaskMode = "deliver" | "command";

/** 任务状态：`active` 参与调度；`paused` 暂停；`done` / `missed` 为终态。 */
export type TaskStatus = "active" | "paused" | "done" | "missed";

/** 一次触发的结局（流水与任务 `lastOutcome` 共用）。 */
export type RunOutcome = "delivered" | "failed" | "skipped" | "missed";

/** 任务定义与状态（权威记录, 原子落盘）。 */
export interface DaemonTask {
  id: string;
  tier: TaskTier;
  mode: TaskMode;
  selector: Selector;
  /** `deliver` = 提示文本；`command` = 完整 slash 命令行。 */
  payload: string;
  /** 目标会话 id（首期只认精确 id）。 */
  sessionId: string;
  status: TaskStatus;
  /** 创建时刻（`every_seconds` 的相位基准）。 */
  createdAt: number;
  /** 下次触发时刻；null = 不再触发。 */
  next: number | null;
  lastFireAt: number | null;
  lastOutcome: RunOutcome | null;
  lastError: string | null;
}

/** 一条运行流水（有界 JSONL）。 */
export interface RunRecord {
  taskId: string;
  /** 任务分档（memory-base 的层由它映射；缺省按 S = session 层处理）。 */
  tier?: TaskTier;
  /** 触发时刻（毫秒）。 */
  at: number;
  sessionId: string;
  mode: TaskMode;
  outcome: RunOutcome;
  error: string | null;
  durationMs: number;
  /** 附加上下文（合并批次里的任务 id 列表、`durable:false` 说明等）。 */
  detail: string | null;
}

/** 新建任务的入参（id / next 由 store 与调度器算）。 */
export interface NewTaskInput {
  tier?: TaskTier;
  mode: TaskMode;
  selector: Selector;
  payload: string;
  sessionId: string;
}

/** 渠道返回码（内核据此记账; 不重试）。 */
export type ChannelErrorCode =
  | "no-active-agent"
  | "command_not_found"
  | "guard_denied"
  | "flush_failed"
  | "error";

export type ChannelResult =
  | {
      ok: true;
      detail?: string;
      /** false = 消息已进内存收件箱, 但落盘未确认（D13：记 delivered + 告警）。 */
      durable?: boolean;
      /** true = 命令类任务的引擎侧安全复查被跳过（fail-open, 对齐 metric-loop）。 */
      guardSkipped?: boolean;
    }
  | {
      ok: false;
      code: ChannelErrorCode;
      message?: string;
      /** false = 消息已进内存收件箱但落盘未确认（D13：记 delivered + 告警）。 */
      durable?: boolean;
    };

/** 宿主 agent 的最小结构面（投递用）。 */
export interface AgentLike {
  session?: unknown;
  status?: string;
  followup?(message: unknown): void;
}

/** 渠道要投递的一批任务（同会话同批合并; 单条命令 = 一条）。 */
export interface DeliveryRequest {
  tasks: readonly DaemonTask[];
  agent: AgentLike;
  signal: AbortSignal;
}

/** 投递渠道契约（将来 herdr / headless 渠道实现同一缝）。 */
export interface DaemonChannel {
  /** `deliver` | `command`（与任务 `mode` 对齐）。 */
  readonly mode: TaskMode;
  deliver(request: DeliveryRequest): Promise<ChannelResult>;
}
