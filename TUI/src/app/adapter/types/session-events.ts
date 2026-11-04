// TUI/src/app/adapter/types/session-events.ts — 会话事件与流式分片（阶段 2 原生形态）

import type {
  CompactionSummaryPayloadLike,
  GoalChangeLike,
  SubagentDescriptorLike,
  TodoItemLike,
} from "./core.ts";

// ---------- 以下 DSH 原生类型仅供阶段 2 adapter 实现参考（app 层不消费） ----------

/** DSH 会话事件类型子集（完整枚举见 KNOWN_SESSION_EVENT_TYPES，generated） */
export type SessionEventType =
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "user/message"
  | "agent/inbox/spliced"
  /** TUI#43：核心摘除已认领的排队项（steer 在 step 边界 / followup 在回合开始） */
  | "assistant/message"
  | "assistant/attempt"
  | "tool/call"
  | "tool/result"
  | "approval/asked"
  | "approval/decided"
  | "approval/policy"
  | "session/end-seed"
  | "session/title"
  | "goal/change"
  | "compaction/start"
  | "compaction/end"
  | "llm/retry"
  | "plan/mode"
  | "sandbox/mode"
  | "permission/preset"
  | "subagent/descriptor"
  | "todo/write"
  | "compaction/summary"
  | "agent-preset/selected"
  | "model/selection"
  | "tool-workflow/run-start"
  | "tool-workflow/agent-start"
  | "tool-workflow/agent-end"
  | "tool-workflow/run-end"
  | "command/run"
  | "command/done"
  | "tool/ptc-dispatch-start"
  | "tool/ptc-dispatch"
  | "hook/invoked"
  | "hook/result"
  | "schedule/change"
  | "compaction/prune"
  | "feedback/record"
  | "feedback/message-delete"
  | "feedback/message-put"
  | "llm/retry-started"
  | "deliverables/presented"
  | "subagent/catalog"
  | "system/message";

/** StreamChunk 子集（assistant/attempt 中 `chunk` 记录的 chunk 载荷；完整变体见 stream 契约） */
export type StreamChunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string | undefined;
      name?: string | undefined;
      argumentsDelta?: string | undefined;
    }
  | {
      type: "block-end";
      index: number;
      blockType?: string | undefined;
      /** 真实 DSH 载荷:完整块文本嵌套在 block.text(与 docs/host/DSH-CTX-API.md StreamChunk 契约一致) */
      block?:
        { type?: string; text?: string; [k: string]: unknown } | undefined;
    }
  | { type: "usage"; index?: number; usage: Record<string, unknown> }
  | { type: "finish"; reason: string; replayState?: unknown };

/** AssistantStreamRecord（assistant/attempt 的 stream 数组元素，见 docs/host/DSH-CTX-API.md §2）：
 *  text/reasoning/tool-call-chunks 为打包的 delta 运行（逐成员等价 text-delta /
 *  reasoning-delta / tool-call-delta）；`chunk` 为原始 StreamChunk（block/usage/finish
 *  恒为 raw chunk 记录）。 */
export type AssistantStreamRecord =
  | {
      type: "text-chunks";
      time0: number;
      index: number;
      dt: readonly number[];
      texts: readonly string[];
    }
  | {
      type: "reasoning-chunks";
      time0: number;
      index: number;
      dt: readonly number[];
      texts: readonly string[];
    }
  | {
      type: "tool-call-chunks";
      time0: number;
      index: number;
      dt: readonly number[];
      id?: string | undefined;
      name?: string | undefined;
      args: readonly string[];
    }
  | { type: "chunk"; time: number; chunk: StreamChunk };

/** DSH 审批请求（approval/request 载荷） */
export interface ApprovalRequest {
  agent: unknown;
  toolName: string;
  callId?: string | undefined;
  reason?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** DSH 审批裁定词表（应答者返回其一，规范化） */
export type ApprovalOutcome =
  "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** 问答单个选项（镜像 dsh-user-questions AskUserQuestionOption） */
export interface QuestionOption {
  label: string;
  description?: string | undefined;
}

/** 问答呈现意图（plan-review：detail 为待审计划，approve 命名的选项即批准） */
export interface QuestionIntent {
  kind: "plan-review";
  approve: string;
}

/** 单个问题（镜像 dsh-user-questions AskUserQuestionItem） */
export interface QuestionItem {
  id: string;
  question: string;
  detail?: string | undefined;
  header?: string | undefined;
  options?: QuestionOption[] | undefined;
  multiSelect?: boolean | undefined;
  intent?: QuestionIntent | undefined;
}

/** 单个回答（镜像 AskUserQuestionAnswerItem） */
export interface QuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string | undefined;
}

/** 整批回答（镜像 AskUserQuestionAnswer） */
export interface QuestionAnswer {
  answers: QuestionAnswerItem[];
}

/** AskUserQuestionRequest 结构面（agent 存活/委托校验由宿主 ask() 完成） */
export interface UserQuestionRequestLike {
  questions: QuestionItem[];
  agent?: unknown | undefined;
  signal?: AbortSignal | undefined;
}

/** 各 type 的 data 载荷（阶段 2 用到的子集） */
/** model/selection 事件载荷宽容视口（ModelSelection{provider,model,reasoningEffort?} 渲染所需字段） */
export interface ModelSelectionLike {
  provider?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: unknown | undefined;
}

export interface SessionEventDataMap {
  "turn/start": { turn: number };
  "turn/end": { turn: number; reason: string };
  "step/start": { turn: number; step: number };
  "step/end": { turn: number; step: number };
  "assistant/attempt": {
    turn: number;
    step: number;
    stream: AssistantStreamRecord[];
  };
  "user/message": { id?: string };
  "assistant/message": {
    turn: number;
    step: number;
    interrupted?: boolean | undefined;
    message?: { content?: unknown[] } | undefined;
  };
  "tool/call": { callId: string; name: string; arguments: string };
  "tool/result": { callId: string; meta?: unknown };
  "approval/asked": {
    id: string;
    toolName: string;
    callId?: string | undefined;
    reason?: string | undefined;
  };
  "approval/decided": { id: string; outcome: ApprovalOutcome };
  "approval/policy": { policy: "ask" | "never" };
  "session/title": { title: string };
  "goal/change": GoalChangeLike;
  "todo/write": { todos: TodoItemLike[] };
  "plan/mode": { active: boolean };
  "sandbox/mode": { mode: string; source?: "delegation" };
  "permission/preset": { preset: string };
  "subagent/descriptor": SubagentDescriptorLike;
  "compaction/summary": CompactionSummaryPayloadLike;
  "agent-preset/selected": { agentPreset: string };
  "model/selection": ModelSelectionLike;
  "tool-workflow/run-start": { runId?: string; name?: string };
  "tool-workflow/agent-start": {
    runId?: string | undefined;
    seq?: number | undefined;
    label?: string | undefined;
    phase?: string | undefined;
    childId?: string | undefined;
  };
  "tool-workflow/agent-end": { runId?: string; seq?: number; outcome?: string };
  "tool-workflow/run-end": { runId?: string; stopReason?: string };
  "command/run": { commandId?: string; name?: string; args?: string };
  "command/done": {
    commandId?: string | undefined;
    kind?: "success" | "error" | "cancel" | undefined;
    text?: string | undefined;
  };
  "tool/ptc-dispatch-start": {
    subCallId?: string | undefined;
    name?: string | undefined;
    arguments?: string | undefined;
  };
  "tool/ptc-dispatch": {
    subCallId?: string | undefined;
    name?: string | undefined;
    isError?: boolean | undefined;
    content?: unknown[] | undefined;
  };
  "hook/invoked": {
    turn?: number | undefined;
    point?: string | undefined;
    handlerId?: string | undefined;
    matcher?: string | undefined;
  };
  "hook/result": {
    turn?: number | undefined;
    point?: string | undefined;
    handlerId?: string | undefined;
    decision?: string | undefined;
    exitCode?: number | undefined;
    durationMs?: number | undefined;
  };
  "schedule/change": {
    version?: number | undefined;
    operation?: string | undefined;
    id?: string | undefined;
    schedule?: unknown | undefined;
    acceptedAt?: number | undefined;
  };
  "compaction/prune": {
    shadowedRange?: { start: number; end: number } | undefined;
    shadowedSeqs?: unknown[] | undefined;
    shadowedTokenCount?: number | undefined;
  };
  "feedback/record": { text?: string };
  "feedback/message-delete": Record<string, unknown>;
  "feedback/message-put": Record<string, unknown>;
  "llm/retry-started": {
    retryId?: string | undefined;
    turn?: number | undefined;
    step?: number | undefined;
    retry?: number | undefined;
  };
  "deliverables/presented": Record<string, unknown>;
  "subagent/catalog": Record<string, unknown>;
  "system/message": Record<string, unknown>;
}

/** DSH 会话事件（session/event 的 event 参数，type 与 data 联动窄化） */
export interface SessionEvent<T extends SessionEventType = SessionEventType> {
  type: T;
  seq: number;
  time: number;
  data: T extends keyof SessionEventDataMap
    ? SessionEventDataMap[T]
    : Record<string, unknown>;
}
