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
  | { type: "session-title"; sessionId: string; title: string }
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
  /** 历史会话列表（newest-first，含当前 live 会话）；宿主未挂载会话查询服务时为 undefined */
  listSessions?(): Promise<SessionInfo[]>;
  /** 会话标题（官方 session/title 事件折叠，dsh-session-title 落盘日志优先）；
   *  无官方标题事件 → undefined（调用方以本地兜底 deriveTitle 补）。 */
  sessionTitle?(sessionId: string): Promise<string | undefined>;
  /** 读取指定历史会话的只读消息列表（损坏会话 reject 结构化错误） */
  readSessionSurface?(id: string): Promise<SessionSurfaceView>;
  /** 运行时切换到持久化会话（agents.resume）：dispose 旧 agent → resume 新 agent，
   *  成功后本 adapter 的活跃会话变为该 id。宿主未挂载 agents.resume 时 reject 提示。 */
  resumeTo?(id: string): Promise<void>;
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
  /** 消息唯一 id（identified 判定依据；官方 createMessage 生成，缺则持久化校验失败） */
  readonly id?: string;
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

/** 单条历史会话记录（宿主 @deepseek-ai/dsh-session-query SessionRecord 的归一化面） */
export interface SessionInfo {
  id: string;
  /** 创建时间（Unix 毫秒） */
  createdAt: number;
  /** 会话启动时工作目录（列表展示用） */
  cwd?: string;
  /** 是否 live 会话（内存 store 中）：当前活跃标 [当前]、其余 live 标 [不可续] 不可选中 */
  live: boolean;
  /** 是否当前活跃 live 会话（adapter 视角权威：初始 opts.sessionId、resume 后切换）；
   *  列表行标记 [当前] */
  current?: boolean;
  /** 是否已持久化到磁盘 */
  persisted: boolean;
  /** 会话标题：官方 session/title 事件标题，缺失时本地兜底（首条用户消息前 30 字符）；
   *  两者皆无 → 省略（列表渲染占位（新会话）） */
  title?: string;
}

/** 历史会话只读表面的归一化消息（v1 仅保留 user/assistant 正文，tool/result 省略） */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

/** 单个历史会话的只读表面视图（归一化后的消息列表） */
export interface SessionSurfaceView {
  sessionId: string;
  messages: HistoryMessage[];
}

/** 宿主会话存储服务结构面（ctx.get('sessions')，dsh-session SessionStore；读 live 会话原始事件用） */
export interface SessionStoreLike {
  get(sessionId: string):
    | {
        id: string;
        events: readonly Record<string, unknown>[];
      }
    | undefined;
}

/** 宿主会话查询服务结构面（ctx.get('sessionQuery')，@deepseek-ai/dsh-session-query；契约见仓库根 DSH-CTX-API.md） */
export interface SessionQueryLike {
  listSessions(): Promise<
    readonly {
      header: { id: string; createdAt: number; cwd?: string };
      live: boolean;
      persisted: boolean;
    }[]
  >;
  /** 完整原始事件日志；内部经 Session.create 全量校验，混合日志（agent/inbox/spliced + 未 identified user/message）会抛校验错，仅作最后兜底 */
  readSession?(sessionId: string): Promise<{
    session: { id: string };
    events: readonly Record<string, unknown>[];
  }>;
  /** 当前模型表面事件（persisted 会话可用；live 会话内存事件缺 surfaceOp 标记 surface fold → 返回空） */
  readSurface?(sessionId: string): Promise<{
    session: { id: string };
    events: readonly Record<string, unknown>[];
  }>;
  /** 折叠最新 session/title 事件标题（官方 @deepseek-ai/dsh-session-title 落盘日志；
   *  live 优先→persisted；无标题事件返回 undefined） */
  readTitle?(sessionId: string): Promise<{ title: string } | undefined>;
  /** 批量折叠标题（单次 corpus 观察，比逐条 readTitle 高效）；缺失服务时省略 */
  readTitleSnapshots?(
    ids: string[],
  ): Promise<
    readonly { sessionId?: string; title?: { title: string } | undefined }[]
  >;
}

/** 结构面：ctx.agents 注册表（仅需 resume：加载持久化会话继续对话）。
 *  官方 AgentRegistry.resume(ownerCtx, {resumeSessionId, agentOptions?, setup?, signal?})
 *  委托给 agent-loop 工厂；要求宿主加载 sessionPersistence 后端。 */
export interface AgentRegistryLike {
  resume(opts: {
    resumeSessionId: string;
    agentOptions?: Record<string, unknown>;
    setup?: (agentCtx: unknown) => unknown;
    signal?: AbortSignal;
  }): Promise<{ agent: unknown; dispose(): Promise<void> }>;
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
  /** ctx.get('sessionQuery') 服务（dsh-session-query）；缺失时历史会话浏览不可用但 adapter 正常启动 */
  sessionQuery?: SessionQueryLike;
  /** ctx.get('sessions') 会话存储服务（读 live 会话原始事件；缺失时仅 live 会话内容读取降级走 readSurface/readSession） */
  sessions?: SessionStoreLike;
  /** ctx.agents（resume 持久化会话用）；缺失时 resumeTo 提示不可用 */
  agents?: AgentRegistryLike;
  /** 创建/resume agent 时注入的 setup（挂 installSessionModelSelection / installToolBootstrap）；
   *  传给 agents.resume 保持钩子在新会话同样生效 */
  setup?: (agentCtx: unknown) => unknown;
  /** 创建 agent 时的 agentOptions（route provider/model/effort），resume 时沿用 */
  agentOptions?: Record<string, unknown>;
  /** 初始 agent handle 的释放函数（main.ts 的 handle.dispose）；resume 切换后由 adapter 负责释放 */
  handleDispose?: () => Promise<void>;
}
