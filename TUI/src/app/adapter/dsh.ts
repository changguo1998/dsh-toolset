// src/app/adapter/dsh.ts — DSH 适配层契约（阶段 1 只定义接口，真实实现属阶段 2）
//
// 接口化让 mock（demo/）与真实（阶段 2）可互换，app 层不感知实现。
// 类型骨架依据官方 deepseek-harness 源码研读沉淀对齐（见 dsh-toolset/DSH-CTX-API.md，
// clone b150a551b8 = dsh-0.1.1-rc.2；早期 wa_dsh_doc.md 社区观测已核实）。
//
// DSH 原生信号 → app 归一化事件的映射（阶段 2 在真实 adapter 内实现）：
//   ctx.sessions.list()                    → { type: 'session-list' }
//   ctx.on('session/event', (session, e))  → 按 e.type 归一化：
//     - 'assistant/chunk' {turn,step,chunk} 中 chunk.type='text-delta'|'reasoning-delta'
//       的 text 合并 → { type: 'stream' }
//     - 'approval/asked' {id,toolName,callId?,reason?} → { type: 'approval' }
//     - 'turn/start' | 'turn/end'          → { type: 'turn-end' }（阶段 2 可加 turn-start UI）
//     - 'user/message' | 'assistant/message' | 'tool/call' | 'tool/result'（阶段 2 可选展示）
//   ctx.on('agent/status', ({agent, status})) → { type: 'agent-status' }
//     （agent/status 是 agent 层事件，不在 session 日志词汇表内）
//
// 审批应答契约：DSH 侧是 waterfall 链事件 'approval/request'(req, next)，监听者返回
// ApprovalOutcome 即裁定；无人应答 fail-closed。request 须在 open turn 内发起。
// adapter 需向 ctx 注册应答者，并把 app 的 approve(id, allow) 映射为
// allow ? 'allowed-once' : 'rejected'。

export type AgentStatus = "idle" | "thinking" | "tool" | "done";

export interface SessionMeta {
  id: string;
  title: string;
}

export interface ApprovalItem {
  id: string;
  prompt: string;
}

/** 应用层收到的归一化事件（见文件头映射表） */
export type DshEvent =
  | { type: "session-list"; sessions: SessionMeta[] }
  | { type: "stream"; sessionId: string; text: string }
  | { type: "approval"; id: string; prompt: string }
  | { type: "agent-status"; sessionId: string; status: AgentStatus }
  | { type: "turn-end" };

/** 应用层对 adapter 的唯一依赖面：事件流入 + 两个出站回调 */
export interface DshAdapter {
  /** 订阅 DSH 会话事件；返回解绑函数 */
  onEvent(cb: (e: DshEvent) => void): () => void;
  /** 发送用户消息 */
  sendMessage(text: string, sessionId?: string): void;
  /** 审批：allow=true 批准（DSH 'allowed-once'），false 拒绝（'rejected'） */
  approve(id: string, allow: boolean): void;
}

// ---------- 以下 DSH 原生类型仅供阶段 2 adapter 实现参考（app 层不消费） ----------

/** DSH 会话事件类型子集（完整词汇表见 KNOWN_SESSION_EVENT_TYPES，generated） */
export type SessionEventType =
  | "turn/start"
  | "turn/end"
  | "user/message"
  | "assistant/message"
  | "assistant/chunk"
  | "tool/call"
  | "tool/result"
  | "approval/asked"
  | "approval/decided"
  | "approval/policy"
  | "session/title"
  | "goal/change"
  | "compaction/start"
  | "compaction/end"
  | "plan/mode"
  | "sandbox/mode"
  | "subagent/descriptor";

/** StreamChunk 子集（assistant/chunk 事件的 chunk 载荷；完整变体见 stream 契约） */
export type StreamChunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: "block-end"; index: number; blockType?: string }
  | { type: "usage"; index?: number; usage: Record<string, unknown> }
  | { type: "finish"; reason: string; replayState?: unknown };

/** DSH 审批请求（approval/request 载荷） */
export interface ApprovalRequest {
  agent: unknown; // dsh-agent Agent 实例
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

/** DSH 审批裁定词表（应答者返回其一，规范化） */
export type ApprovalOutcome =
  "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** DSH 会话事件原始载荷（session/event 的 event 参数；阶段 2 按 type 分开处理） */
export interface SessionEvent {
  type: SessionEventType;
  seq: number;
  sessionId: string;
  [key: string]: unknown; // 各 type 特有字段：turn/step/title/payload...
}
