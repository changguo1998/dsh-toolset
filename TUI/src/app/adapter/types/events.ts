// TUI/src/app/adapter/types/events.ts — 宿主事件面（DshEvent 联合）

import type { TurnEndReason } from "../../state.ts";

import type {
  AgentRowInfo,
  AgentStatus,
  CompactionSummaryPayloadLike,
  GoalActivation,
  GoalOperation,
  GoalRefLike,
  GoalSnapshotLike,
  NoticeTone,
  SessionMeta,
  TodoItemLike,
} from "./core.ts";
import type { QuestionItem } from "./session-events.ts";
import type { CommandPanelKind, CommandPanelRow, JobInfo } from "./agent.ts";

export type DshEvent =
  | { type: "session-list"; sessions: SessionMeta[] }
  | { type: "session-title"; sessionId: string; title: string }
  | { type: "stream"; sessionId: string; text: string }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "approval"; id: string; prompt: string }
  /** 审批已被裁定（超时 / abort）：app 关闭面板并提示，避免「面板仍开着但决议已失效」（3.3.2） */
  | { type: "approval-closed"; id: string; reason: "timeout" | "abort" }
  | { type: "question"; id: string; questions: QuestionItem[] }
  | { type: "agent-status"; sessionId: string; status: AgentStatus }
  | { type: "notice"; text: string; error?: boolean; tone?: NoticeTone }
  /** #3：宿主的 `turn/start`（携带回合号）——会话区回合分隔线要显示 `⇆N` */
  | { type: "turn-start"; turn?: number }
  /** P1：收尾原因（宿主 turn/end reason.kind）→ 用户块终态符号依据 */
  | { type: "turn-end"; reason?: TurnEndReason }
  | {
      type: "tool-call";
      sessionId: string;
      name: string;
      summary: string;
      /** 宿主工具调用 id：审批草稿据此回查命令/参数（3.3.3） */
      callId?: string;
    }
  | {
      type: "tool-result";
      sessionId: string;
      ok: boolean;
      detail: string;
      meta?: unknown;
    }
  | {
      type: "model-selection";
      sessionId: string;
      provider?: string;
      model?: string;
      reasoningEffort?: unknown;
    }
  | {
      type: "usage";
      sessionId: string;
      input: number;
      output: number;
      cacheRead: number;
      contextWindow?: number;
    }
  /** P8：sessionId 供「压缩中算活跃」按会话标记 */
  | { type: "compaction"; phase: "start" | "end"; sessionId?: string }
  /** TUI#10：子代理生命周期变化（subagent/start · subagent/end）→ /agents 面板即时刷新 */
  | { type: "subagent-activity" }
  /** TUI#39：子代理目录快照（adapter 归一化 subagents 目录）→ 状态列 Agents 块（按会话切片） */
  | { type: "agents-changed"; sessionId: string; agents: AgentRowInfo[] }
  /** TUI#43：核心摘除了已认领的排队项（`removedCount > 0`）。
   *  `target` = "next-step"（steer 在 step 边界被认领）/ "next-turn"（followup 在回合开始）。 */
  | { type: "inbox-claim"; target: "next-step" | "next-turn" }
  /** BACKLOG TUI#49：rule-engine 注入消息（`source.kind:'rule-engine'`，正文 `[RULE]` 开头）
   *  的实时显示通道——按用户块追加（历史路径自然折叠为用户消息；`id` 供去重）。 */
  | { type: "rule-injection"; id: string; text: string }
  | {
      type: "retry";
      attempt: number;
      max: number;
      delayMs: number;
      code: string;
      message?: string;
    }
  // --- P2 阶段 A 新增（按 sessionId 隔离；goal 为判别联合，compaction 摘要携完整 raw） ---
  | {
      type: "goal-change";
      sessionId: string;
      operation: Exclude<GoalOperation, "clear">;
      goal: GoalSnapshotLike;
      roundsStarted?: number;
      createdAt?: number;
      updatedAt?: number;
    }
  | {
      type: "goal-change";
      sessionId: string;
      operation: "clear";
      cleared: GoalRefLike;
      clearedAt?: number;
    }
  /** goal 自动续轮开关变化（`goal/activation-changed` 总线事件；**进程本地**态：
   *  `activation` 缺省 = 宿主该会话已无当前 goal → 清该会话记录） */
  | {
      type: "goal-activation";
      sessionId: string;
      goalId?: string;
      activation?: GoalActivation;
    }
  | { type: "todo-write"; sessionId: string; todos: TodoItemLike[] }
  | {
      type: "mode";
      sessionId: string;
      kind: "plan" | "sandbox" | "permission";
      /** plan 存 "on"/"off"；sandbox/permission 存原始值字符串 */
      value: string;
    }
  | {
      /** TUI 本地开关回填（切换会话时由 TUI 侧快照恢复；宿主日志不记录这两项） */
      type: "ui-flags";
      sessionId: string;
      /** 模型输出符号统一（/symbol-unify）；缺省 = 该会话无记录 */
      symbolUnify?: boolean;
      /** P7：垂直状态列是否显示（Ctrl+S 切换）；缺省 = 该会话无记录（默认显示） */
      statusColumn?: boolean;
      /** #9：下半区（Turn 流 + 工具区）是否显示（Ctrl+T 切换）；缺省 = 该会话无记录（默认显示） */
      lowerPanes?: boolean;
    }
  | {
      type: "step";
      sessionId: string;
      turn: number;
      step: number;
      phase: "start" | "end";
      /** P6：事件信封时间（epoch ms）——分组头时间戳；缺省由 reducer 回退当前时刻 */
      time?: number;
    }
  | {
      type: "subagent";
      sessionId: string;
      label: string;
      mode: "one-shot" | "continuable";
    }
  | {
      type: "approval-policy";
      sessionId: string;
      policy: "ask" | "never";
    }
  | {
      type: "compaction-summary";
      sessionId: string;
      text: string;
      raw: CompactionSummaryPayloadLike;
    }
  | {
      type: "workflow";
      sessionId: string;
      phase: "run-start" | "agent-start" | "agent-end" | "run-end";
      /** run-start=工作流名；agent-start=成员 label；agent-end/run-end 缺省用序号 */
      label: string;
      detail?: string;
      /** tool-workflow run id（/workflows 运行集合分组用） */
      runId: string;
    }
  | {
      type: "command";
      sessionId: string;
      phase: "run" | "done";
      name: string;
      text?: string;
      ok?: boolean;
    }
  | {
      type: "code-dispatch";
      sessionId: string;
      phase: "start" | "settle";
      name: string;
      summary: string;
      ok: boolean;
    }
  | {
      type: "hook";
      sessionId: string;
      phase: "invoked" | "result";
      point: string;
      decision?: string;
      ok: boolean;
    }
  | {
      type: "schedule";
      sessionId: string;
      operation: "create" | "delete" | "dispatch";
      id?: string;
    }
  | {
      type: "compaction-prune";
      sessionId: string;
      nodeCount: number;
      tokenCount: number;
    }
  | { type: "feedback"; sessionId: string; text: string }
  | { type: "retry-started"; sessionId: string; attempt: number }
  | { type: "agent-preset"; sessionId: string; preset: string }
  | { type: "jobs-changed"; sessionId: string; jobs: JobInfo[] }
  | {
      type: "command-panel-data";
      kind: CommandPanelKind;
      rows: CommandPanelRow[];
      error?: string;
    };

/** 应用层对 adapter 的唯一依赖面：事件流入 + 出站回调（消息/命令/审批/打断） */
