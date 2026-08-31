// src/app/adapter/types.ts — DSH 适配层类型契约（自 dsh.ts 拆出，零运行时值）
//
// 全部为纯类型（type/interface），无运行时依赖；dsh.ts 与 normalize.ts 从这里导入，
// 外部消费方（app/demo/tests）继续从 ./adapter/dsh.ts 的显式重导取得。

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
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "approval"; id: string; prompt: string }
  | { type: "question"; id: string; questions: QuestionItem[] }
  | { type: "agent-status"; sessionId: string; status: AgentStatus }
  | { type: "notice"; text: string; error?: boolean }
  | { type: "turn-end" };

/** 应用层对 adapter 的唯一依赖面：事件流入 + 出站回调（消息/命令/审批/打断） */
export interface DshAdapter {
  /** 订阅 DSH 会话事件；返回解绑函数 */
  onEvent(cb: (e: DshEvent) => void): () => void;
  /** 发送用户消息 */
  sendMessage(text: string, sessionId?: string): void;
  /**
   * 执行 slash 命令行(形如 /name args...)。约定：命令通过注册表调用 → 结果经
   * notice 事件回报；未命中(undefined)→ notice 提示未知命令(fail-close)，绝不
   * 作为用户消息发送给模型。渲染类命令(/help /clearscreen /cls /quit)由 app 层本地表处理，
   * 不经过本方法。
   */
  runCommand(line: string, sessionId?: string): void;
  /** 释放：中止在途命令分发、解绑运行时监听；可选(mock 无状态可缺省) */
  dispose?(): void;
  /** 审批：allow=true 批准（DSH 'allowed-once'），false 拒绝（'rejected'） */
  approve(id: string, allow: boolean): void;
  /** 提交问答整批答案（id = question 事件 id；Esc 取消走 cancelQuestion） */
  answerQuestion(id: string, answer: QuestionAnswer): void;
  /** 取消问答（Esc）：reject 当前 ask，不打断 turn */
  cancelQuestion(id: string): void;
  /** 打断当前思考/turn（真实实现映射 agent.cancel({kind:'user'})；宿主无取消能力时为 no-op） */
  interrupt(): void;
  /** 查询可用模型目录（provider + 各 provider 可用模型 + 当前默认选择） */
  modelCatalog(): Promise<ModelCatalog>;
  /** 切换当前会话模型（只改会话内 ref，绝不落盘）；返回应用后的选择 */
  setSessionModel(sel: ModelSelection): Promise<ModelSelection>;
  /** 查询指定 provider/model 的可选思考等级；非思考模型或服务缺失返回 undefined */
  modelEfforts(
    provider: string,
    model: string,
  ): Promise<{ id: string; name: string }[] | undefined>;
}

/** 模型目录条目（/model 列表展示用） */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  description?: string;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** 会话级模型选择引用：current 应用于下一 step；assembled 为当前 step 组装时的快照 */
export interface SessionModelSelectionRef {
  current: ModelSelection | undefined;
  assembled?: ModelSelection | undefined;
}

export interface ModelCatalog {
  providers: { provider: string; name?: string }[];
  models: ModelInfo[];
  current: ModelSelection | undefined;
}

// ---------- 以下 DSH 原生类型仅供阶段 2 adapter 实现参考（app 层不消费） ----------

/** DSH 会话事件类型子集（完整枚举见 KNOWN_SESSION_EVENT_TYPES，generated） */
export type SessionEventType =
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "user/message"
  | "assistant/message"
  | "assistant/chunk"
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
  | "plan/mode"
  | "sandbox/mode"
  | "subagent/descriptor"
  | "agent/preset/selected";

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
  | {
      type: "block-end";
      index: number;
      blockType?: string;
      /** 真实 DSH 载荷:完整块文本嵌套在 block.text(与 DSH-CTX-API.md StreamChunk 契约一致) */
      block?: { type?: string; text?: string; [k: string]: unknown };
    }
  | { type: "usage"; index?: number; usage: Record<string, unknown> }
  | { type: "finish"; reason: string; replayState?: unknown };

/** DSH 审批请求（approval/request 载荷） */
export interface ApprovalRequest {
  agent: unknown;
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

/** DSH 审批裁定词表（应答者返回其一，规范化） */
export type ApprovalOutcome =
  "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** 问答单个选项（镜像 dsh-user-questions AskUserQuestionOption） */
export interface QuestionOption {
  label: string;
  description?: string;
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
  detail?: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  intent?: QuestionIntent;
}

/** 单个回答（镜像 AskUserQuestionAnswerItem） */
export interface QuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** 整批回答（镜像 AskUserQuestionAnswer） */
export interface QuestionAnswer {
  answers: QuestionAnswerItem[];
}

/** ctx.get('userQuestions') 结构面（dsh-user-questions 0.1.1：单 provider registerProvider） */
export interface UserQuestionsLike {
  registerProvider(provider: {
    ask(req: UserQuestionRequestLike): Promise<QuestionAnswer>;
  }): () => void;
}

/** AskUserQuestionRequest 结构面（agent 存活/委托校验由宿主 ask() 完成） */
export interface UserQuestionRequestLike {
  questions: QuestionItem[];
  agent?: unknown;
  signal?: AbortSignal;
}

/** 各 type 的 data 载荷（阶段 2 用到的子集） */
export interface SessionEventDataMap {
  "turn/start": { turn: number };
  "turn/end": { turn: number; reason: string };
  "step/start": { turn: number; step: number };
  "step/end": { turn: number; step: number };
  "assistant/chunk": { turn: number; step: number; chunk: StreamChunk };
  "user/message": { id?: string };
  "assistant/message": { turn: number; step: number };
  "tool/call": { callId: string; name: string; arguments: string };
  "tool/result": { callId: string };
  "approval/asked": {
    id: string;
    toolName: string;
    callId?: string;
    reason?: string;
  };
  "approval/decided": { id: string; outcome: ApprovalOutcome };
  "approval/policy": { policy: "ask" | "never" };
  "session/title": { title: string };
  "agent/preset/selected": { preset: string };
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

// ---------------------------------------------------------------------------
// 阶段 2 真实实现：createRealDshAdapter
// ---------------------------------------------------------------------------

/** DSH 宿主的 slim 结构面（cordis Context 的结构子集），便于独立测试。 */
export interface DshRuntime {
  on(
    event: string,
    listener: (...args: unknown[]) => unknown,
  ): (() => void) | void;
}

/** 结构型 agent（真机来自 ctx.agents.create() 的 AgentHandle.agent） */
export interface DshAgentLike {
  readonly session: { readonly id: string };
  followup(message: DshUserMessageLike): void;
}

/** 结构型用户消息（真机应改用 createUserMessage 生成，字段同构） */
export interface DshUserMessageLike {
  readonly role: "user";
  readonly content: readonly { type: "text"; text: string }[];
  readonly source: { kind: "user" } | { kind: "plugin"; plugin: string };
}

/**
 * 结构面：官方 @deepseek-ai/dsh-commands 注册表（ctx.commands.execute）。
 * execute(agent, line, images, signal) → CommandExecution | undefined；
 * undefined 表示未命中注册表(fail-close)。与官方 packages/interaction/commands/
 * src/types.ts 契约一致(DSH-CTX-API.md)。
 */
export interface DshCommandLike {
  execute(
    agent: unknown,
    line: string,
    images?: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> | unknown;
}

/** ctx.get('llm') 服务（dsh-llm LlmRuntime）结构面，零运行时依赖 */
export interface LlmLike {
  listProviders?(): readonly { id?: string; name?: string }[];
  listModels?(provider: string):
    | Promise<
        readonly {
          provider?: string;
          id?: string;
          name?: string;
          description?: string;
        }[]
      >
    | readonly {
        provider?: string;
        id?: string;
        name?: string;
        description?: string;
      }[];
  /** 精确路由推理元数据（结构面：官方 LlmService.resolveModelInfo → LlmResolvedModelInfo.reasoning） */
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: unknown,
  ):
    | Promise<
        | {
            reasoning?: {
              efforts?: readonly { id?: string; name?: string }[];
              defaultEffort?: string;
            };
          }
        | undefined
      >
    | {
        reasoning?: {
          efforts?: readonly { id?: string; name?: string }[];
          defaultEffort?: string;
        };
      }
    | undefined;
}

export interface AgentDefaultModelLike {
  currentSelection?():
    { provider?: string; model?: string; reasoningEffort?: string } | undefined;
}

export interface RealAdapterOptions {
  runtime: DshRuntime;
  sessionId: string;
  /** app 使用的瘦 agent(用于 followup) */
  agent: DshAgentLike;
  /** 真实 Agent(注册表作用域查找用，通常与 main.ts 的 handle.agent 相同) */
  commandAgent?: unknown;
  /** DSH commands 注册表(来自 ctx.get('commands')，bundle 已挂载) */
  commands?: DshCommandLike;
  /** 审批弹窗超时（ms），超时未答 fallback 'cancelled'；默认 60s */
  approvalTimeoutMs?: number;
  /** 打断当前思考/turn 的回调（调用 agent.cancel({kind:'user'})）；宿主无 cancel 能力时不传 */
  interrupt?: () => void;
  /** ctx.get('llm') 服务（dsh-llm LlmRuntime）结构面 */
  llm?: LlmLike;
  /** 会话级模型选择引用；提供时 setSessionModel 只改 ref、不落盘 */
  sessionModel?: SessionModelSelectionRef;
  /** ctx.get('agentDefaultModel') 服务（只读兜底：会话未切换时作为目录/状态显示与组装默认） */
  defaultModel?: AgentDefaultModelLike;
  /** ctx.get('userQuestions') 服务（dsh-user-questions 0.1.1 单 provider）；缺失时提问功能不可用但 adapter 正常启动 */
  userQuestions?: UserQuestionsLike;
}
