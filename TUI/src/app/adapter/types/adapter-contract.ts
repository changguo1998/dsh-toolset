// src/app/adapter/types/adapter-contract.ts — DshAdapter 对外契约

import type { SessionUiState } from "../session-ui-state.ts";
import type { FileMentionCandidate } from "../../file-mention.ts";

import type { DshEvent } from "./events.ts";
import type { ModelCatalog, ModelReasoning, ModelSelection } from "./model.ts";
import type { QuestionAnswer } from "./session-events.ts";
import type {
  SessionDeleteResult,
  SessionInfo,
  SessionSurfaceView,
} from "./session.ts";
import type { PermissionPresetInfo } from "./agent.ts";
import type { ConfigEntrySummary } from "./tools.ts";
import type { AgentGroupViewLike } from "./services.ts";
import type { ManagedTier, MemoryRowRef } from "./memory.ts";
import type {
  AgentPresetInfo,
  ContractParseResult,
  WorkflowRunLike,
} from "./channel.ts";

export interface DshAdapter {
  /** 当前活跃会话 id（App 启动初期 state 未建立时，Mode 快照等按 adapter 视角取用） */
  readonly sessionId?: string;
  /** 宿主 agent 是否支持官方 steer（BACKLOG TUI#36）：false 时 `<` 模式提交回落 followup */
  canSteer?(): boolean;
  /** TUI#40：本次进程启动即恢复了持久化会话（CLI `--resume` / `-c`）→ App 启动后补折叠历史 */
  readonly resumedAtLaunch?: boolean;
  /** 订阅 DSH 会话事件；返回解绑函数 */
  onEvent(cb: (e: DshEvent) => void): () => void;
  /** 发送用户消息；`target:'next-step'` = 官方 steer（BACKLOG TUI#36：投递到最近 step 边界），
   *  宿主 agent 无 steer 时回落 followup 并由 App 侧提示降级 */
  sendMessage(text: string, sessionId?: string, target?: "next-step"): void;
  /**
   * 启动自检（锚定解锁，BACKLOG TUI「启动后自动触发首轮工具调用」）：代替用户发一条
   * `[AUTO]` 自检消息（`source.kind:"tool-bootstrap"`），驱动模型发起首个工具调用完成
   * 解锁。仅启动期在门控通过后由 App 调用；未接线（mock / 旧接线）时缺省不下发。
   * 通道（BACKLOG #2）：优先 `steer`（next-step：当前回合即可领取；空闲时立刻起回合），
   * 宿主无 `steer` 时回落 `followup`（降级不丢）。
   */
  sendBootstrapKickoff?(): void;
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
  /** 取消审批（Esc / Ctrl-C 等）：settle 为 'cancelled'，面板关闭由 app 侧发起（3.3.1） */
  cancelApproval(id: string): void;
  /**
   * 审批超时实际生效值（ms，BACKLOG 3.3.2）：App 侧倒计时据此显示，保证「倒计时归零」
   * 与「宿主侧裁定」始终同源；缺省实现可不提供（App 回落 60_000）。
   */
  approvalTimeoutMs?(): number;
  /**
   * 停止该审批的超时计时（BACKLOG 3.3.5）：用户在面板内有过任何操作后调用——此后不再
   * 自动裁定（与问答面板「人在场就不催」一致）。缺省实现可不提供（视为无此能力）。
   */
  stopApprovalTimeout?(id: string): void;
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
  /**
   * 提示文本 `@` 提及的候选（ctx.fileReferences.list，服务由 dsh-file-reference-local 提供）。
   * 服务未挂载 / agent 未就绪 → undefined（App 侧据此关闭该特性：`@` 按普通字符输入）。
   * `signal` 取消过期请求；查询抛错一律归一为空数组（静默降级，不弹错、不打断输入）。
   */
  listFileCandidates?(
    query: string,
    signal: AbortSignal,
  ): Promise<readonly FileMentionCandidate[]>;
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
  /** 退出前删除**当前活跃会话**（仅「清理并退出」收尾调用）：与 deleteSession 相反，
   *  刻意允许 activeSessionId —— 调用点固定在 adapter.dispose() 之后（handle 已释放、
   *  进程即将退出，无并发打开风险）；失败只返回原因，不阻断退出。
   *  宿主无会话查询服务时为 undefined。 */
  deleteSessionForExit?(id: string): SessionDeleteResult;
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
  /** 请求刷新 jobs 快照（读 ctx.jobs.list 后经 jobs-changed 事件推送） */
  refreshJobs?(): Promise<void>;
  /** 拉取 skills 列表并按 `filter`（名称/描述/适用场景子串，不区分大小写）过滤后
   *  经 command-panel-data 事件推送；宿主未挂载 → reject */
  refreshSkills?(filter?: string): Promise<void>;
  /** 读取单个 skill 正文（Enter 详情）；服务缺失或读取失败 → undefined */
  skillDetail?(name: string): Promise<string | undefined>;
  /** 拉取子代理列表（`listDescendants(activeSessionId)` 取 depth=1 直接子代）并归一化后经
   *  command-panel-data 推送；宿主未挂载 → reject */
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
  /** 列出 `configEditor.configuration()` 的可编辑条目（id / name / inherited / override）；
   *  服务缺失或形状不符 → undefined（调用方 notice「config-editor 不可用」） */
  configEntries?(): Promise<readonly ConfigEntrySummary[] | undefined>;
  /** 按条目 id 重新解析当前 Entry 并调 `configEditor.edit()` 改写其 config（校验 / 原子写 /
   *  与 HMR 串行都由宿主完成）；服务缺失 → reject，宿主拒绝 → reject 原文透出 */
  editConfigEntry?(
    id: string,
    change: (
      current: Record<string, unknown>,
      inherited: Record<string, unknown>,
    ) => Record<string, unknown>,
  ): Promise<void>;
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
  /** `/memory search`：跨全域检索（未挂载 → undefined，调用方提示） */
  memorySearch?(args: {
    query: string;
    limit?: number;
  }): Promise<unknown[] | undefined>;
  /** `/memory list`：跨 kind 列举（管理面定位；未挂载 → undefined） */
  memoryList?(args: {
    tier?: ManagedTier;
    kind?: string;
    limit?: number;
  }): Promise<unknown[] | undefined>;
  /** `/memory remove`：删除 U / P 条目（参数级错误折算成 reason） */
  memoryForget?(ref: MemoryRowRef): Promise<{
    ok: boolean;
    removed: number;
    reason?: string;
  }>;
  /** `/memory replace`：就地更新 U / P 条目（失败时原行不动） */
  memoryReplace?(
    ref: MemoryRowRef,
    patch: { content: string; title?: string; importance?: number },
  ): Promise<{ ok: boolean; skipped?: string }>;
  /** `/memory add`：用户直写（管理面；kind 必填，tier 只接受 project / user） */
  memoryAdd?(input: {
    content: string;
    kind: string;
    tier: ManagedTier;
  }): Promise<{ ok: boolean; skipped?: string }>;
  /** 请求刷新循环面板（经 metric-loop `list()` 归一化为行后推送）；未挂载 → reject */
  refreshLoops?(): Promise<void>;
  /** 读取单个循环详情（Enter 详情；list() 中定位）；服务缺失或未找到 → undefined */
  loopDetail?(id: string): Promise<string | undefined>;
  /** `/group`：经 agentGroup 只读服务 `status()` 拉取当前会话群组清单/单组视图
   *  （未挂载 → reject；失败面 error/reason/next 原样透传） */
  readGroupStatus?(
    sessionId: string,
    groupName?: string,
  ): Promise<
    | {
        ok: true;
        groups: readonly { name: string; view: AgentGroupViewLike }[];
      }
    | { ok: false; error: string; reason?: string; next?: string }
  >;
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
