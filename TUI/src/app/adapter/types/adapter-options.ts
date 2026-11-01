// src/app/adapter/types/adapter-options.ts — 适配器装配选项

import type { BlockDelivery } from "../../layout/pipeline/types.ts";

import type { SessionModelSelectionRef } from "./model.ts";
import type {
  AgentDefaultModelLike,
  DshAgentLike,
  DshCommandLike,
  DshRuntime,
  LlmLike,
} from "./runtime.ts";
import type {
  SessionQueryLike,
  SessionStoreLike,
  SessionTitleLike,
} from "./session.ts";
import type {
  AgentRegistryLike,
  PermissionPresetServiceLike,
  SkillsLike,
  SubagentsLike,
} from "./agent.ts";
import type { ConfigEditorLike, SettingsLike, ToolsLike } from "./tools.ts";
import type {
  AgentGroupLike,
  SecurityGuardLike,
  TaskEngineLike,
} from "./services.ts";
import type { KnowledgeServiceLike, MetricLoopLike } from "./memory.ts";
import type {
  AgentPresetsLike,
  GoalContractServiceLike,
  JobsLike,
  SearchProviderLike,
  SessionChannelLike,
  WebSearchLike,
  WorkflowEngineLike,
} from "./channel.ts";

/**
 * 结构面：官方 @deepseek-ai/dsh-file-reference 的 FileReferenceService
 * （ctx.fileReferences.list）。宿主 provider（dsh-file-reference-local）给的是
 * **仅路径**候选，带确定性排序与有界索引；本 TUI 只读取路径与类别，不读文件内容。
 * 字段按宽松口径读取（unknown 收窄，与 commands / sessionQuery 等结构面同构）。
 */
export interface FileReferenceLike {
  list(
    agent: unknown,
    query: string,
    signal: AbortSignal,
  ):
    | Promise<readonly { path?: unknown; kind?: unknown }[]>
    | readonly { path?: unknown; kind?: unknown }[];
}

export interface RealAdapterOptions {
  runtime: DshRuntime;
  sessionId: string;
  /** TUI#40：本次进程**启动即恢复**了持久化会话（CLI `--resume` / `-c`）——
   *  adapter 据此暴露 `resumedAtLaunch`，App 启动时补一次历史折叠（历史区直接可见既有消息） */
  resumedAtLaunch?: boolean;
  /** 六步流水线接收层 sink（由 App 注入）：adapter 把宿主
   *  两条线（持久线结算 / 实时线增量）归一成「块交付」投递到这里；缺省不投递、零开销。 */
  onDelivery?: (delivery: BlockDelivery) => void;
  /** app 使用的瘦 agent(用于 followup) */
  agent: DshAgentLike;
  /** 真实 Agent(注册表作用域查找用，通常与 main.ts 的 handle.agent 相同) */
  commandAgent?: unknown;
  /** DSH commands 注册表(来自 ctx.get('commands')，bundle 已挂载) */
  commands?: DshCommandLike;
  /** 审批弹窗超时（ms），超时未答按默认拒绝裁定（'rejected'）；缺省 60_000 ms（1 min） */
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
  /** ctx.get('agentPresets') 服务（dsh-agent-presets）；缺失时目录同步降级（状态列无 preset 可选项） */
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
  /** ctx.get('configEditor') 服务（dsh-config-editor）；缺失时 /config 提示不可用。
   *  main.ts 以惰读 getter 传入（该行与 TUI 并发装载，apply 期快照可能为空）。 */
  configEditor?: ConfigEditorLike;
  /** ctx.get('taskEngine') 只读查询面（task-engine cordis provide）；缺失时 /task 提示不可用 */
  taskEngine?: TaskEngineLike;
  /** ctx.get('guard') 只读查询面（security-guard cordis provide）；缺失时 /guard 提示不可用 */
  guard?: SecurityGuardLike;
  /** ctx.get('memory') 只读查询面（memory-base cordis provide）；缺失时 /memory 提示不可用 */
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
  /** ctx.get('sessionChannel') 只读面（session-channel 插件 provide）；状态列 Agents 块取
   *  会话别名用，缺失 / 失败静默（不阻塞目录刷新） */
  sessionChannel?: () => SessionChannelLike | undefined;
  /** ctx.get('fileReferences') 服务（dsh-file-reference，本 profile 由 file-reference-local
   *  提供实现）；缺失时 `@` 提及补全整体关闭——`@` 按普通字符输入，无面板也无报错 */
  fileReferences?: FileReferenceLike;
  /** ctx.get('agentGroup') 只读服务面（agent-group cordis provide）；缺失时 /group 提示不可用 */
  agentGroup?: AgentGroupLike;
}
