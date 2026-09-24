// src/app/adapter/types.ts — DSH 适配层类型契约（自 dsh.ts 拆出，零运行时值）
//
// 全部为纯类型（type/interface），无运行时依赖；dsh.ts 与 normalize.ts 从这里导入，
// 外部消费方（app/demo/tests）继续从 ./adapter/dsh.ts 的显式重导取得。

import type { SessionUiState } from "./session-ui-state.ts";

export type AgentStatus = "idle" | "thinking" | "tool" | "done";

export interface SessionMeta {
  id: string;
  title: string;
}

export interface ApprovalItem {
  id: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// P2 领域载荷结构面（rc.2 源码核实；宽松读取，字段缺省不抛错）
// ---------------------------------------------------------------------------

/** goal/change 的操作动词（packages/goal/goal/src/domain.ts GoalOperation） */
export type GoalOperation =
  "create" | "edit" | "pause" | "resume" | "complete" | "block" | "clear";

/** goal 引用（GoalRef：id + revision） */
export interface GoalRefLike {
  id: string;
  revision?: number;
}

/** goal 全量快照（GoalSnapshot：id/revision/objective/phase/blockedReason?/maxGoalRounds） */
export interface GoalSnapshotLike extends GoalRefLike {
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  blockedReason?: { code: string; message: string };
  maxGoalRounds?: number;
}

/** goal/change 载荷（判别联合：非 clear 全量快照 / clear 墓碑） */
export type GoalChangeLike =
  | {
      kind: "goal/change";
      version?: 1;
      operation: Exclude<GoalOperation, "clear">;
      goal: GoalSnapshotLike;
      roundsStarted?: number;
      createdAt?: number;
      updatedAt?: number;
    }
  | {
      kind: "goal/change";
      version?: 1;
      operation: "clear";
      cleared: GoalRefLike;
      clearedAt?: number;
    };

/** todo 条目（TodoItem：content + status；全量快照 last-write-wins，无 id） */
export interface TodoItemLike {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** subagent/descriptor 载荷（SubagentDescriptorData 结构面） */
export interface SubagentDescriptorLike {
  version?: number;
  mode: "one-shot" | "continuable";
  provider: string;
  label?: string;
  agentProvider?: string;
  agentModel?: string;
  persona?: string;
}

/** compaction/summary 的 content block（text 提取用） */
export interface ContentBlockLike {
  type?: string;
  text?: string;
}

/** compaction/summary 完整原始载荷（compaction/src/types.ts 结构面；reducer 整份保留） */
export interface CompactionSummaryPayloadLike {
  compactionId?: string;
  sourceCommandId?: string;
  summary?: ContentBlockLike[];
  /** 0.1.2-rc.1 新增：本次摘要阴影替换的 log 区间（SessionSeq[start,end] 含端点） */
  shadowedRange?: { start: number; end: number };
  shadowedSeqs?: number[];
  shadowedTokenCount?: number;
  provider?: string;
  model?: string;
  maxTokens?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  };
}

/**
 * tool/result.meta 的宽容视口（0.1.2-rc.1 起工具可回附任意 JsonValue meta，官方形状
 * 未文档化；dsh-tool-fs 现以 {before, after} 存 LF 规范化全文）。渲染方命中
 * before/after 均为 string 时自行计算行级摘要（(+N/-M)），其他形状忽略——保持降级。
 */
export interface ToolResultMetaLike {
  [key: string]: unknown;
  before?: unknown;
  after?: unknown;
}

/** notice/tool 行 tone——4 级语义 5 色值：log 灰=进度/状态无需关注；info 蓝=需用户了解；warn 黄=可绕开的运行错误/副作用危险警示；result 级互斥：error 红=操作失败（用户输入命令的结果一律 error、须修复继续）、success 绿=重要操作成功 */
export type NoticeTone = "log" | "info" | "warn" | "error" | "success";
/** 应用层收到的归一化事件（见文件头映射表） */
export type DshEvent =
  | { type: "session-list"; sessions: SessionMeta[] }
  | { type: "session-title"; sessionId: string; title: string }
  | { type: "stream"; sessionId: string; text: string }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "approval"; id: string; prompt: string }
  | { type: "question"; id: string; questions: QuestionItem[] }
  | { type: "agent-status"; sessionId: string; status: AgentStatus }
  | { type: "notice"; text: string; error?: boolean; tone?: NoticeTone }
  | { type: "turn-end" }
  | { type: "tool-call"; sessionId: string; name: string; summary: string }
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
  | { type: "compaction"; phase: "start" | "end" }
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
      /** 活动区详略（/verbose）；缺省 = 该会话无记录 */
      verbose?: boolean;
      /** 模型输出符号统一（/symbol-unify）；缺省 = 该会话无记录 */
      symbolUnify?: boolean;
    }
  | {
      type: "step";
      sessionId: string;
      turn: number;
      step: number;
      phase: "start" | "end";
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
export interface DshAdapter {
  /** 当前活跃会话 id（App 启动初期 state 未建立时，Mode 快照等按 adapter 视角取用） */
  readonly sessionId?: string;
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
  /** 宿主命令注册表目录（name+desc，输入补全候选人；服务未挂载/未暴露 list → undefined） */
  commandList?(): readonly { name: string; desc: string }[] | undefined;
  /** 切换当前会话模型（只改会话内 ref，绝不落盘）；返回应用后的选择 */
  setSessionModel(sel: ModelSelection): Promise<ModelSelection>;
  /** 查询指定 provider/model 的可选思考等级；非思考模型或服务缺失返回 undefined */
  modelEfforts(
    provider: string,
    model: string,
  ): Promise<{ id: string; name: string }[] | undefined>;
  /** 查询指定 provider/model 的推理元数据（可选思考等级 + provider 默认等级）；
   *  defaultEffort 即请求未显式指定时实际生效的等级（provider 级 reasoning 配置，如 max）；
   *  非思考模型或服务缺失返回 undefined */
  modelReasoning?(
    provider: string,
    model: string,
  ): Promise<ModelReasoning | undefined>;
  /** 历史会话列表（newest-first，含当前 live 会话）；宿主未挂载会话查询服务时为 undefined */
  listSessions?(): Promise<SessionInfo[]>;
  /** 会话标题（官方 session/title 事件折叠，dsh-session-title 落盘日志优先）；
   *  无官方标题事件 → undefined（调用方以本地兜底 deriveTitle 补）。 */
  sessionTitle?(sessionId: string): Promise<string | undefined>;
  /** 重命名当前会话标题（宿主 sessionTitle.rename(live Session, title)，首参为 Session 对象）；
   *  服务未挂载或活跃会话不可用 → reject，调用方 notice「sessionTitle 服务不可用」。 */
  renameSession?(title: string): Promise<void>;
  /** 读取指定历史会话的只读消息列表（损坏会话 reject 结构化错误） */
  readSessionSurface?(id: string): Promise<SessionSurfaceView>;
  /** 运行时切换到持久化会话（agents.resume）：dispose 旧 agent → resume 新 agent，
   *  成功后本 adapter 的活跃会话变为该 id。宿主未挂载 agents.resume 时 reject 提示。 */
  resumeTo?(id: string): Promise<void>;
  /** 运行时新建会话（`/new`）：dispose 旧 agent → agents.create 全新会话（同一 setup /
   *  agentOptions），成功后本 adapter 的活跃会话变为新 id（旧会话保留在磁盘，可经
   *  /session 切回）。宿主未暴露 agents.create 时省略 → /new 提示不可用。 */
  newSession?(): Promise<{ id: string }>;
  /** 删除持久化会话（文件级：单段安全 id + realpath 包含性校验后删除会话目录）；
   *  当前活跃会话一律拒绝；live 会话由调用方（面板）先拒绝。宿主无会话查询服务时为 undefined。 */
  deleteSession?(id: string): Promise<SessionDeleteResult>;
  /** 回填会话状态：启动/恢复会话时从宿主日志（log-only 事件）与 TUI 侧快照折叠
   *  model / plan / sandbox / permission / policy / goal / todo / TUI 本地开关，
   *  并 emit 对应事件（另把模型写回会话内选择引用）；宿主无读取面时静默 */
  restoreSessionState?(sessionId: string): Promise<void>;
  /** 读取 TUI 侧会话状态快照（`<会话目录>/tui-state.json`）；无快照/损坏 → undefined */
  readSessionUiState?(sessionId: string): SessionUiState | undefined;
  /** 落盘 TUI 侧会话状态快照（会话目录不存在或不可写 → false，静默降级） */
  saveSessionUiState?(sessionId: string, state: SessionUiState): boolean;
  /** 切换当前会话审批策略（ask=每次询问 / never=恒拒自动放行）；
   *  宿主未挂载 ctx.approval 时 reject，调用方 notice「审批策略服务不可用」。 */
  setApprovalPolicy?(policy: "ask" | "never"): Promise<void>;
  /** 权限预设目录（rc.2 ctx.permissionPresets：当前值 + 可用名 + 描述）；宿主未挂载 → undefined */
  permissionCatalog?(): Promise<PermissionPresetInfo | undefined>;
  /** agent 预设目录（可用预设 + 当前选中 + 默认）；宿主未挂载 ctx.agentPresets → undefined */
  agentPresetCatalog?(): Promise<AgentPresetInfo | undefined>;
  /** 切换会话 agent 预设（经 ctx.agentPresets.recompose）；宿主缺失/未暴露 → reject */
  selectAgentPreset?(id: string): Promise<void>;
  /** 请求刷新 jobs 快照（读 ctx.jobs.list 后经 jobs-changed 事件推送） */
  refreshJobs?(): Promise<void>;
  /** 拉取 skills 列表并按 `filter`（名称/描述/适用场景子串，不区分大小写）过滤后
   *  经 command-panel-data 事件推送；宿主未挂载 → reject */
  refreshSkills?(filter?: string): Promise<void>;
  /** 读取单个 skill 正文（Enter 详情）；服务缺失或读取失败 → undefined */
  skillDetail?(name: string): Promise<string | undefined>;
  /** 拉取子代理列表（`listChildren(activeSessionId)`）并归一化后经 command-panel-data 推送；
   *  宿主未挂载 → reject */
  refreshAgents?(): Promise<void>;
  /** 中断一个子代理（`interrupt(id, {kind:'user', parentSessionId: activeSessionId})`）；
   *  服务缺失或调用失败 → reject */
  interruptAgent?(childSessionId: string): Promise<void>;
  /** 拉取工具 schema（`schemas()` 全局视图）按 `filter` 过滤后经 command-panel-data 推送 */
  refreshTools?(filter?: string): Promise<void>;
  /** 读取单个工具的详情文本（Enter 详情）；服务缺失或读取失败 → undefined */
  toolDetail?(name: string): Promise<string | undefined>;
  /** 读取全部设置（`settings.describe()` → `ns：value` 多行，secret 脱敏）；
   *  服务缺失或读取失败 → undefined（调用方 notice「settings 服务不可用」或空态） */
  readSettings?(): Promise<string | undefined>;
  /** 分叉当前会话为新会话（`sessions.fork(activeSessionId)`，后两参省略）；
   *  错误码 5 个映射为中文文案后 reject；服务缺失 → reject（提示 sessions 未挂载） */
  forkCurrentSession?(): Promise<{ id: string; title?: string }>;
  /** 请求刷新任务面板（经 task-engine `query()` 只读面归一化为行后推送）；
   *  宿主未挂载 → reject（提示 taskEngine 未挂载） */
  refreshTasks?(): Promise<void>;
  /** 读取单个任务详情（Enter 详情；在 query().tasks 中定位）；服务缺失或未找到 → undefined */
  taskDetail?(id: string): Promise<string | undefined>;
  /** 请求刷新守卫面板（经 security-guard `recent()` 归一化为行后推送）；未挂载 → reject */
  refreshGuard?(): Promise<void>;
  /** 读取策略快照（`policy()` → 4 行摘要）；服务缺失 → undefined */
  guardPolicy?(): Promise<string | undefined>;
  /** 读取知识库概要（就绪/路径/chunk·source 计数）；服务缺失 → reject，
   *  未就绪 → resolve 说明文本（调用方 info） */
  memorySummary?(): Promise<string>;
  /** 请求刷新循环面板（经 metric-loop `list()` 归一化为行后推送）；未挂载 → reject */
  refreshLoops?(): Promise<void>;
  /** 读取单个循环详情（Enter 详情；list() 中定位）；服务缺失或未找到 → undefined */
  loopDetail?(id: string): Promise<string | undefined>;
  /** 契约回读：解析 objective 文本中的 Done-when 段为条款并归一行摘要文本
   *  （健康/缺失判定在调用方）。目标文本来自 state.goalBySession 的
   *  GoalSnapshot.objective；内置回读实现，不依赖跨包 import。 */
  contractSummary?(objectiveText: string): ContractParseResult;
  /** 取消后台任务（映射 ctx.jobs.kill）；宿主缺失 → reject */
  killJob?(id: string): Promise<void>;
  /** 请求刷新 /workflows 面板：读 adapter 维护的 workflow runs 集合 → command-panel-data
   *  推送（行：name + 阶段/成员数·done；running → status active（黄）、done → inactive）。
   *  宿主未挂载 workflowEngine → reject（调用方 warn 不空开面板）。 */
  refreshWorkflows?(): Promise<void>;
  /** /workflows 只读运行集合（测试/契约用；无则空） */
  workflowRuns?: readonly WorkflowRunLike[];
  /** /council 二次意见：并行拉起 count 个评审子代理（ctx.subagents.start）对 target 各自
   *  给独立意见，任一失败降级保留其余；返回汇总文本（notice 展示，≤4 行）。宿主未挂载
   *  subagents.start → reject（调用方 warn 不假启动）。 */
  council?(target: string, count?: number): Promise<string>;
  /** /search：并行调用多 provider（host web 派生 + options.searchProviders），合并→URL 去重
   *  →query-token 关联度排序后归一化行推 command-panel-data(kind=search)；单 provider 失败
   *  降级保留其余、全部失败 → reject（调用方 warn）。宿主无任何 provider → reject。 */
  search?(query: string, maxResults?: number): Promise<void>;
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

/** 模型推理元数据（状态栏/面板展示用，不触发请求）：
 *  efforts = 可选思考等级；defaultEffort = provider 配置的默认等级（请求未显式指定时实际生效值） */
export interface ModelReasoning {
  efforts?: { id: string; name: string }[] | undefined;
  defaultEffort?: string | undefined;
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

/** 单次模型调用的 token 用量（assistant/message.usage 载荷；cache 字段可选） */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
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

/** AssistantStreamRecord（assistant/attempt 的 stream 数组元素，见 DSH-CTX-API.md §10）：
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
      id?: string;
      name?: string;
      args: readonly string[];
    }
  | { type: "chunk"; time: number; chunk: StreamChunk };

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

/** AskUserQuestionRequest 结构面（agent 存活/委托校验由宿主 ask() 完成） */
export interface UserQuestionRequestLike {
  questions: QuestionItem[];
  agent?: unknown;
  signal?: AbortSignal;
}

/** 各 type 的 data 载荷（阶段 2 用到的子集） */
/** model/selection 事件载荷宽容视口（ModelSelection{provider,model,reasoningEffort?} 渲染所需字段） */
export interface ModelSelectionLike {
  provider?: string;
  model?: string;
  reasoningEffort?: unknown;
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
    interrupted?: boolean;
    message?: { content?: unknown[] };
  };
  "tool/call": { callId: string; name: string; arguments: string };
  "tool/result": { callId: string; meta?: unknown };
  "approval/asked": {
    id: string;
    toolName: string;
    callId?: string;
    reason?: string;
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
    runId?: string;
    seq?: number;
    label?: string;
    phase?: string;
    childId?: string;
  };
  "tool-workflow/agent-end": { runId?: string; seq?: number; outcome?: string };
  "tool-workflow/run-end": { runId?: string; stopReason?: string };
  "command/run": { commandId?: string; name?: string; args?: string };
  "command/done": {
    commandId?: string;
    kind?: "success" | "error" | "cancel";
    text?: string;
  };
  "tool/ptc-dispatch-start": {
    subCallId?: string;
    name?: string;
    arguments?: string;
  };
  "tool/ptc-dispatch": {
    subCallId?: string;
    name?: string;
    isError?: boolean;
    content?: unknown[];
  };
  "hook/invoked": {
    turn?: number;
    point?: string;
    handlerId?: string;
    matcher?: string;
  };
  "hook/result": {
    turn?: number;
    point?: string;
    handlerId?: string;
    decision?: string;
    exitCode?: number;
    durationMs?: number;
  };
  "schedule/change": {
    version?: number;
    operation?: string;
    id?: string;
    schedule?: unknown;
    acceptedAt?: number;
  };
  "compaction/prune": {
    shadowedRange?: { start: number; end: number };
    shadowedSeqs?: unknown[];
    shadowedTokenCount?: number;
  };
  "feedback/record": { text?: string };
  "feedback/message-delete": Record<string, unknown>;
  "feedback/message-put": Record<string, unknown>;
  "llm/retry-started": {
    retryId?: string;
    turn?: number;
    step?: number;
    retry?: number;
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
  /** 注册表目录（官方 commands.list(agent) → CommandDescriptor[]）；宿主未暴露时省略。
   *  仅取 name/description，调用方按宽松字段读取（unknown 收窄）。 */
  list?(agent: unknown): readonly { name?: unknown; description?: unknown }[];
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
            context?: { contextWindow?: number };
          }
        | undefined
      >
    | {
        reasoning?: {
          efforts?: readonly { id?: string; name?: string }[];
          defaultEffort?: string;
        };
        context?: { contextWindow?: number };
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
  /** 空会话（persisted 且从未有用户消息）：供列表标注与“清理空会话”的计数与范围判定；
   *  读取面不可用或未判定时省略（不臆断为空） */
  isEmpty?: boolean;
  /** 会话标题：官方 session/title 事件标题，缺失时本地兜底（首条用户消息前 30 字符）；
   *  两者皆无 → 省略（列表渲染占位（新会话）） */
  title?: string;
}

/** 删除会话结果：ok=false 时 reason 为可见失败原因（不可删 / 未找到 / 越界 / IO 失败） */
export type SessionDeleteResult = { ok: true } | { ok: false; reason: string };

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

/** 宿主会话标题服务结构面（ctx.get('sessionTitle')，@deepseek-ai/dsh-session-title）；
 *  rename 首参为 **live Session 对象**（非 id 字符串），返回快照；服务缺失时 /rename 提示不可用。 */
/** 宿主会话标题快照结构面（`sessionTitle.rename` 返回；TUI 不解释内部结构，只看调用是否抛错） */
export interface SessionTitleSnapshotLike {
  title?: string;
}

/** live Session 句柄：对 TUI 不透明（不读任何字段），仅原样透传给宿主服务。 */
export type LiveSessionHandle = Record<string, unknown>;

export interface SessionTitleLike {
  /** 首参为 live Session 对象（见 LiveSessionHandle） */
  rename?(session: LiveSessionHandle, title: string): SessionTitleSnapshotLike;
}

/** 宿主会话存储服务结构面（ctx.get('sessions')，dsh-session SessionStore；读 live 会话原始事件用） */
export interface SessionStoreLike {
  get(sessionId: string):
    | {
        id: string;
        events: readonly Record<string, unknown>[];
      }
    | undefined;
  /** 分叉源会话为新会话（dsh-session SessionStore.fork；后两参可省：省略 boundary =
   *  源会话当前最后事件、省略 childSessionId = store 的 id 策略）。返回 live Session；
   *  错误码 5 个（SESSION_NOT_FOUND/SESSION_NOT_LIVE/SESSION_ALREADY_EXISTS/
   *  INVALID_BOUNDARY/OPEN_TURN）以宿主错误（code 字段）抛出。 */
  fork?(
    source: string,
    boundary?: unknown,
    childSessionId?: string,
  ): { id: string; title?: string } | undefined;
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
  /**
   * 批量折叠标题（单次 corpus 观察，比逐条 readTitle 高效；缺失服务时省略）。
   * 官方契约为 settlement 形态：每条为 fulfilled（value: {session, title?}）或
   * rejected（reason）——仅消费 fulfilled 的 value.title。
   */
  readTitleSnapshots?(ids: string[]): Promise<
    readonly (
      | {
          sessionId: string;
          status: "fulfilled";
          value: { title?: { title: string } | undefined };
        }
      | { sessionId: string; status: "rejected"; reason?: unknown }
    )[]
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
  /** 新建会话（官方 agents.create；sessionId 缺省由宿主生成）。/new 用；
   *  老宿主只暴露 resume 时省略 → /new 提示不可用。 */
  create?(opts: {
    sessionId?: string;
    meta?: { cwd?: string };
    agentOptions?: Record<string, unknown>;
    setup?: (agentCtx: unknown) => unknown;
  }): Promise<{ agent: unknown; dispose(): Promise<void> }>;
}

/** 权限预设目录信息（rc.2 ctx.permissionPresets 结构面：names + current + 展示描述） */
export interface PermissionPresetInfo {
  /** 当前有效预设名（不匹配表内任何预设时为 'custom'） */
  current: string;
  /** 可切换预设名（表声明顺序） */
  names: string[];
  /** 预设展示名与说明（PresetSpec.name/description；缺省回落键名） */
  entries: { key: string; name: string; description?: string }[];
}

/** ctx.get('permissionPresets') 结构面（rc.2 PermissionPresetService：names + current） */
export interface PermissionPresetServiceLike {
  names: readonly string[];
  current(events: readonly unknown[]): string;
  /** 新会话默认预设（dsh-permission-presets defaultPreset；缺失时 Mode 快照跳过兜底） */
  readonly defaultPreset?: string;
}

/** 单后台任务快照（rc.2 JobSnapshot 结构面子集：id/kind/label/status/detail；供 UI 展示） */
export interface JobInfo {
  id: string;
  kind: string;
  label: string;
  status: string;
  detail?: string;
}

// ---------- 共享列表面板（/skills、/agents、/tools；契约见 COMMANDS-SPEC.md §4） ----------

/** 共享列表面板 kind（批次 2 仅 skills；agents/tools 由批次 3 接入） */
export type CommandPanelKind =
  | "skills"
  | "agents"
  | "tools"
  | "task"
  | "guard"
  | "loop"
  | "workflows"
  | "search";

/** 共享列表面板行（kind 无关的归一化渲染输入） */
export interface CommandPanelRow {
  /** 主文本（skill 名 / agent label / 工具名） */
  title: string;
  /** 副文本（描述 / detail；可空） */
  detail?: string;
  /** 状态语义（可选；渲染层经 JobsPanel.statusMark 映射符号与颜色，无则默认前景） */
  status?: string;
  /** 主操作载荷（Enter 时回传，如 skill 名称） */
  payload?: string;
}

/** 宿主 skills 服务条目结构面（dsh-skill SkillSummary 子集） */
export interface SkillSummaryLike {
  name: string;
  description?: string;
  whenToUse?: string;
  provider?: string;
}

/** 宿主 skills 服务完整定义结构面（SkillDefinition 子集，含正文） */
export interface SkillDefinitionLike extends SkillSummaryLike {
  content?: string;
}

/** 宿主 skills 服务结构面（ctx.get('skills')，@deepseek-ai/dsh-skill）；
 *  服务层 `list()` / `get(name)` 均为同名/skill 名字符串（provider 层 candidate 不出现）。 */
export interface SkillsLike {
  /** 可用 skill 元数据（无参调用；options 省略 = 全局层） */
  list?(): Promise<readonly SkillSummaryLike[]>;
  /** 单个 skill 定义（含 content 正文；Enter 详情用） */
  get?(name: string): Promise<SkillDefinitionLike | undefined>;
}

// ---------- subagents / tools 服务结构面（批次 3：/agents、/tools） ----------

/** 宿主 subagents 服务条目结构面（dsh-subagent SubagentListEntry 结构化子集） */
export interface SubagentEntryLike {
  /** 判别：child = 可用条目；diagnostic = 投影失败条目（只读展示，不可中断） */
  kind?: string;
  /** 子会话 id（可中断目标；diagnostic 条目即使带 id 也不可中断） */
  id?: string;
  /** 子代理类型：one-shot / continuable */
  mode?: string;
  /** 创建标签 */
  label?: string;
  /** 存活态：running / inactive */
  activity?: string;
  /** 是否有子代 */
  hasChildren?: boolean;
  /** diagnostic 条目的原因：corrupt / unsupported / unavailable */
  reason?: string;
}

/** 子代理一次 one-shot run 的返回（dsh-subagent SubagentRun 结构化子集） */
export interface SubagentRunLike {
  /** parent 作用域 run id（本地即子会话 id） */
  id?: string;
  /** 结算结果：run 不 reject 于子级失败（stopReason:'error' 消费方映射） */
  result?: Promise<{
    output?: readonly ContentBlockLike[];
    text?: string;
    stopReason?: string;
    error?: string;
  }>;
}

/** 宿主 subagents 服务结构面（ctx.get('subagents')，@deepseek-ai/dsh-subagent）；
 *  列条目须用 `listChildren(parentSessionId)`（`list()` 返回 provider 名，不是 agent）。 */
export interface SubagentsLike {
  listChildren?(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly SubagentEntryLike[]>;
  /** 中断一个 live 子代理的当前 turn（authority = {kind:'user', parentSessionId}） */
  interrupt?(
    targetSessionId: string,
    authority: { kind: "user"; parentSessionId: string },
  ): void;
  /** 拉起一个 one-shot 子代理（dsh-subagent `start(name, request)`；/council 评审用）。
   *  request: { label?, prompt: ContentBlock[], parent, signal?, agentOptions? }。
   *  宿主未提供 → /council 提示不可用不假启动。 */
  start?(
    name: string,
    request: {
      label?: string;
      prompt: readonly ContentBlockLike[];
      parent: unknown;
      signal?: AbortSignal;
      /** 高规格评审模型偏好（宿主暴露 agentOptions 能力时透传，否则默认） */
      agentOptions?: Record<string, unknown>;
    },
  ): Promise<SubagentRunLike> | SubagentRunLike;
}

/** 宿主工具 schema 结构面（dsh-llm ToolSchema 子集） */
export interface ToolSchemaLike {
  name: string;
  description?: string;
}

/** 宿主 ScopeKey 的 TUI 侧形态：对 TUI 不透明（不读任何字段），默认省略即全局视图。 */
export type ScopeKeyLike = Record<string, unknown>;

/** 宿主 tools 服务结构面（ctx.get('tools')，@deepseek-ai/dsh-tools）；
 *  `schemas()` 省略 scope = 全局视图（已核实：peek/chainLayers 对 undefined 返回空叠加）。 */
export interface ToolsLike {
  schemas?(scope?: ScopeKeyLike): readonly ToolSchemaLike[];
  get?(name: string, scope?: ScopeKeyLike): Record<string, unknown> | undefined;
}

/** 宿主设置描述符结构面（dsh-settings SettingsDescriptor 子集：:50-73，含 ns/value/revision） */
export interface SettingsDescriptorLike {
  ns: string;
  value?: unknown;
  revision?: number | string;
  base?: unknown;
  user?: unknown;
  applies?: unknown;
  /** role('secret') 字段名列表；非空时该 ns 的 value 不应明文展示 */
  secrets?: readonly string[];
}

/** 宿主设置服务结构面（ctx.get('settings')，dsh-settings SettingsProvider；
 *  /settings 为只读展示：describe() 一次枚举 ns + 当前值，不做写回。
 *  首版输出仅用 describe()；get(ns) 单读未接入（宿主返回 unknown，
 *  需在接入时定义域类型后再暴露）。 */
export interface SettingsLike {
  describe?(options?: {
    redactSecrets?: boolean;
  }): readonly SettingsDescriptorLike[];
}

/** task-engine 只读查询面快照（C1 前置；host `TaskEngine.query()` 返回形态的 TUI 侧宽松子集） */
export interface TaskEngineTaskLike {
  id: string;
  parentId: string | null;
  order: number;
  title: string;
  status: string;
  needDecompose: boolean;
  children?: readonly TaskEngineTaskLike[];
}

export interface TaskEngineQueryLike {
  tasks: readonly TaskEngineTaskLike[];
  frameStack: readonly string[];
  activeCount: number;
  isComplete: boolean;
}

/** ctx.get('taskEngine') 只读查询面（task-engine cordis provide；缺失时 /task 提示不可用） */
export interface TaskEngineLike {
  query?(): TaskEngineQueryLike;
  frameStack?(): readonly string[];
}

/** security-guard 判定记录（C3 前置；`GuardRecord` 的 TUI 侧宽松子集） */
export interface GuardRecordLike {
  toolName: string;
  verdict: "allow" | "deny";
  reason?: string;
  time: number;
}

/** security-guard 策略快照（C3 前置；`PolicySnapshot` 的 TUI 侧宽松子集） */
export interface PolicySnapshotLike {
  enabled: boolean;
  commandBlacklist?: {
    enabled?: boolean;
    rules?: readonly { id: string; reason: string }[];
    allowPatterns?: readonly string[];
  };
  sensitiveFiles?: {
    enabled?: boolean;
    rules?: readonly { id: string; reason: string }[];
    allowedPaths?: readonly { id: string; reason: string }[];
  };
}

/** ctx.get('guard') 只读查询面（security-guard cordis provide；缺失时 /guard 提示不可用） */
export interface SecurityGuardLike {
  recent?(): readonly GuardRecordLike[];
  policy?(): PolicySnapshotLike;
}

/** knowledge-base 概要（C4 前置；`KnowledgeBundleSummary` 的 TUI 侧宽松子集） */
export interface KnowledgeBundleSummaryLike {
  ready: boolean;
  dbPath: string;
  chunkCount: number;
  sourceCount: number;
}

/** ctx.get('knowledge') 只读查询面（knowledge-base cordis provide；缺失时 /memory 提示不可用） */
export interface KnowledgeServiceLike {
  getSummary?(): KnowledgeBundleSummaryLike | undefined;
  whenReady?(): Promise<{ summary?(): KnowledgeBundleSummaryLike | undefined }>;
}

/** metric-loop 循环概要素（C5 前置；`LoopSummary` 的 TUI 侧宽松子集） */
export interface LoopSummaryLike {
  id: string;
  status?: string;
  stopReason?: string | null;
  measureCmd?: string | null;
  direction?: "min" | "max";
  window?: number;
  maxRounds?: number;
  rounds?: number;
  best?: number | null;
  streak?: number;
  updatedAt?: number;
}

/** ctx.get('metricLoop') 只读查询面（metric-loop cordis provide，C5 已挂载；缺失时 /loop 提示不可用）。
 *  首版输出仅用 list()；status(id) 单查未被 TUI 消费，接入时定义域类型后再暴露。 */
export interface MetricLoopLike {
  list?(): readonly LoopSummaryLike[];
}

/** tool-workflow 运行视图（/workflows 只读面板行数据源；runId 分组，增量事件维护） */
export interface WorkflowRunLike {
  /** tool-workflow run id */
  id: string;
  /** 工作流名（run-start 载荷 name） */
  name: string;
  /** 最近阶段：agent-start（有成员在跑）/ agent-end / run-end */
  phase: string;
  /** running = 运行中；done = run-end 已收尾 */
  status: "running" | "done";
  /** 已发布成员数（agent-start 计数） */
  members: number;
  /** 已结算成员数（agent-end 计数） */
  membersDone: number;
  /** 更新时间戳（事件到达时刻） */
  updatedAt: number;
}

/** ctx.get('workflowEngine') 宿主面（dsh-workflow）；仅作 /workflows 挂载探测，
 *  面板数据源为 tool-workflow/* 会话事件流（经 adapter 维护 runs 集合）。 */
export interface WorkflowEngineLike {
  /** 引擎是否可用（宿主面存在即视为可用；TUI 不做引擎操作） */
  readonly present?: true;
}

/** 单一搜索结果来源（dsh-web WebSearchSource 结构化子集；TUI 聚合管线单位） */
export interface SearchSourceLike {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

/** ctx.get('web') 宿主搜索面（dsh-web WebRuntime 结构化子集）。注意 seam 是
 *  **provider-selecting**（`search()` 运行单个所选 provider；多 provider 无显式 id 时
 *  抛 WEB_PROVIDER_AMBIGUOUS）——**不**替 TUI 做多引擎聚合；聚合是消费方职责。 */
export interface WebSearchLike {
  search?(
    request: { query: string; maxResults?: number },
    signal?: AbortSignal,
  ): Promise<{
    content?: string;
    sources: readonly SearchSourceLike[];
    truncated?: boolean;
  }>;
}

/** TUI 侧搜索 provider 抽象：多引擎聚合管线的单位（host web 派生一个 + options.searchProviders
 *  注入更多；每个 provider 独立 search，并行调用）。 */
export interface SearchProviderLike {
  /** provider 稳定 id（行 detail 中来源标注用） */
  id: string;
  /** 跑一次搜索（消费方负责并行与容错） */
  search(
    query: string,
    signal?: AbortSignal,
  ): Promise<{ sources: readonly SearchSourceLike[] }>;
}

/** goal-contract 契约条款（`Done-when:` 段 JSON 数组元素；TUI 侧只读子集） */
export interface ContractClauseLike {
  id?: string;
  check: string;
  level?: string;
  command?: string;
}

/** 契约回读结果（TUI 内置与 goal-contract `parseContract` 同构：定位 `Done-when:`
 *  独占标记行，段后 JSON 解析为条款；无标记行 → 空条款。返回 error 而非 throw，
 *  方便 notice 层直接呈现解析失败原因。） */
export interface ContractParseResult {
  ok: boolean;
  /** objective 文本（去掉 Done-when 段） */
  objective: string;
  /** 条款（ok=false 时为 []） */
  clauses: ContractClauseLike[];
  /** 解析失败原因（ok=false 时存在） */
  error?: string;
}

/** goal-contract 只读查询面（goal-contract cordis provide）。若宿主未挂载
 *  （当前 goal-contract 无 provide），TUI 走包入口不可行的内置回读支路。 */
export interface GoalContractServiceLike {
  /** 契约回读：解析 objective 文本中的 Done-when 段为条款；失败 → error */
  parseContract?(objectiveText: string): ContractParseResult;
}

/** agent 预设目录信息（rc.2 ctx.agentPresets 结构面：list + defaultId + 事件回读当前） */
export interface AgentPresetInfo {
  /** 当前会话选中预设（agent-preset/selected 事件回读；未选中 → ""） */
  current: string;
  /** 未来会话默认预设（AgentPresets.defaultId） */
  defaultId: string;
  /** 可用预设（list() 声明序：id/name/description） */
  presets: { id: string; name: string; description?: string }[];
}

/** ctx.get('agentPresets') 结构面（rc.2 AgentPresets：list/defaultId/recompose） */
export interface AgentPresetsLike {
  list(): Promise<unknown[]>;
  readonly defaultId?: string;
  /** 会话级切换：把 agentCtx 的组合树重组成指定预设（rc.2 recompose） */
  recompose?(agentCtx: unknown, id: string): Promise<unknown>;
}

/** ctx.get('jobs') 结构面（rc.2 JobRegistry：list/kill/onJobsChanged） */
export interface JobsLike {
  list(caller?: unknown): ReadonlyArray<Record<string, unknown>>;
  kill?(id: string, caller?: unknown, reason?: string): string;
  onJobsChanged?(listener: (...args: unknown[]) => void): () => void;
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
  /** ctx.get('sessionQuery') 服务（dsh-session-query）；缺失时历史会话浏览不可用但 adapter 正常启动 */
  sessionQuery?: SessionQueryLike;
  /** TUI 侧会话状态快照的查找根目录（tui-state.json 所在会话目录）；缺省 sessionRoots()
   *  （DSH_TUI_SESSION_ROOT → $DSH_HOME/sessions → ~/.dsh-tui/sessions），测试可注入临时根 */
  sessionStateRoots?: readonly string[];
  /** ctx.get('sessions') 会话存储服务（读 live 会话原始事件；缺失时仅 live 会话内容读取降级走 readSurface/readSession） */
  sessions?: SessionStoreLike;
  /** ctx.agents（resume 持久化会话用）；缺失时 resumeTo 提示不可用 */
  agents?: AgentRegistryLike;
  /** 创建/resume agent 时注入的 setup（挂 installSessionModelSelection / installToolBootstrap）；
   *  传给 agents.resume 保持钩子在新会话同样生效 */
  setup?: (agentCtx: unknown) => unknown;
  /** 创建 agent 时的 agentOptions（route provider/model/effort），resume 时沿用 */
  agentOptions?: Record<string, unknown>;
  /** 新建会话的 meta（`agents.create({ meta })`，如 { cwd }）；resumeTo 不用（会话自带 meta）。
   *  缺省不传 meta，与宿主自己的默认策略一致。 */
  sessionMeta?: Record<string, unknown>;
  /** 初始 agent handle 的释放函数（main.ts 的 handle.dispose）；resume 切换后由 adapter 负责释放 */
  handleDispose?: () => Promise<void>;
  /** ctx.get('permissionPresets') 服务（dsh-permission-presets）；缺失时 /permission 提示不可用 */
  permissionPresets?: PermissionPresetServiceLike;
  /** ctx.get('agentPresets') 服务（dsh-agent-presets）；缺失时 /preset 提示不可用 */
  agentPresets?: AgentPresetsLike;
  /** ctx.get('jobs') 服务（dsh-jobs，dsh-base 默认装配 jobs-local）；缺失时 /jobs 提示不可用 */
  jobs?: JobsLike;
  /** ctx.get('sessionTitle') 服务（dsh-session-title）；缺失时 /rename 提示不可用 */
  sessionTitle?: SessionTitleLike;
  /** ctx.get('skills') 服务（dsh-skill）；缺失时 /skills 提示不可用 */
  skills?: SkillsLike;
  /** ctx.get('subagents') 服务（dsh-subagent）；缺失时 /agents 提示不可用 */
  subagents?: SubagentsLike;
  /** ctx.get('tools') 服务（dsh-tools）；缺失时 /tools 提示不可用 */
  tools?: ToolsLike;
  /** ctx.get('settings') 服务（dsh-settings）；缺失时 /settings 提示不可用 */
  settings?: SettingsLike;
  /** ctx.get('taskEngine') 只读查询面（task-engine cordis provide）；缺失时 /task 提示不可用 */
  taskEngine?: TaskEngineLike;
  /** ctx.get('guard') 只读查询面（security-guard cordis provide）；缺失时 /guard 提示不可用 */
  guard?: SecurityGuardLike;
  /** ctx.get('knowledge') 只读查询面（knowledge-base cordis provide）；缺失时 /memory 提示不可用 */
  knowledge?: KnowledgeServiceLike;
  /** ctx.get('metricLoop') 只读查询面（metric-loop cordis provide）；缺失时 /loop 提示不可用 */
  metricLoop?: MetricLoopLike;
  /** ctx.get('goalContract') 只读查询面（goal-contract cordis provide）。当前 goal-contract
   *  不 expose 服务，TUI 以内置回读兜底（/contract）。 */
  goalContract?: GoalContractServiceLike;
  /** ctx.get('workflowEngine') 服务（dsh-workflow）；缺失时 /workflows 提示不可用 */
  workflowEngine?: WorkflowEngineLike;
  /** ctx.get('web') 服务（dsh-web）；缺失时 /search 提示不可用 */
  web?: WebSearchLike;
  /** TUI 本地可配置搜索 provider 集合（多引擎聚合管线 inputs；可与 web 派生 provider 并存） */
  searchProviders?: readonly SearchProviderLike[];
}
