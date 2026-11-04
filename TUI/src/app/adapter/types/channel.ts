// TUI/src/app/adapter/types/channel.ts — 规则告警、会话通道、工作流与搜索

/** ctx.get('ruleEngine') 服务面（rule-engine 插件 provide；缺失或未实现 onNotice 时 TUI
 *  不订阅，告警仍走插件侧 stderr 兜底。消费侧懒读，容忍插件装载顺序，见 index.ts
 *  App.ruleEngine()；BACKLOG「rule-engine 的用户提示应显示在回合区」方案 B）。 */
export interface RuleEngineLike {
  /** 订阅插件告警（完整展示行 + tone）；返回注销函数。 */
  onNotice?(listener: (event: RuleEngineNotice) => void): () => void;
}

/** 插件告警事件：`text` = 完整展示行（含 `[rule-engine] ` 前缀），tone 三档。 */
export interface RuleEngineNotice {
  text: string;
  tone?: "log" | "warn" | "error";
}

/** ctx.get('sessionChannel') 只读面（session-channel 插件 provide；缺失或未设别名时
 *  状态行不显示别名段，见 BACKLOG TUI#48）。消费侧懒读，容忍插件装载顺序。 */
export interface SessionChannelLike {
  /** 别名清单（含在线标记）；插件未连接等失败情形返回 `{ ok: false, error }`。 */
  aliasList(): Promise<{
    ok: boolean;
    aliases?: Array<{ alias: string; sessionId: string; online: boolean }>;
    error?: string;
  }>;
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

/** ctx.get('jobs') 结构面（dsh JobRegistry，0.1.7-rc.2 单一形态）。
 *  caller = 裸 `SessionId` 字符串（owner 判定 `job.owner.id === caller`）；`list`/`kill` 同形态。
 *  变化订阅走 `events.subscribe(filter, listener)`（按 owner 过滤的事件流）。 */
export interface JobsLike {
  list(caller?: string): ReadonlyArray<Record<string, unknown>>;
  kill?(id: string, caller?: string, reason?: string): string;
  /** 按 owner 过滤的事件流（filter 形如 `{ owner: sessionId }`）；不可用时退化为面板打开时拉取 */
  events?: {
    subscribe?(
      filter: unknown,
      listener: (...args: unknown[]) => void,
    ): () => void;
  };
}
