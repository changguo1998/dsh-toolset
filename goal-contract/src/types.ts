// src/types.ts — goal-contract 领域类型与宿主结构化接口
//
// 领域类型对齐 task-engine 的 Acceptance 契约（见 task-engine/src/types.ts）：
// 单条 Done-when 条款字段与 Acceptance（id/check/level/command/outputSchema）
// 完全一致；本包不引入对 task-engine 的 npm 依赖，schema 通过对齐源文件获得，
// 跨插件通信只经宿主 ctx 服务面（userQuestions / goals）。
//
// 宿主接口为结构化最小型（参照 task-engine/src/main.ts 模式）：不 import
// @deepseek-ai/cordis（dsh workspace 包，非 npm 依赖），服务惰性取用与降级。

/** 三级验收 level（对齐 task-engine AcceptanceLevel）。 */
export type ClauseLevel = "mechanical" | "semantic" | "human";

/** 单条 Done-when 契约条款（字段对齐 task-engine Acceptance）。 */
export interface ContractClause {
  /** 唯一 id（供后续验收判定引用）。 */
  id: string;
  /** 验证内容描述。 */
  check: string;
  /** 验收层级：mechanical（命令退出码 0 即过）/ semantic（结构化裁决）/ human（人工确认）。 */
  level: ClauseLevel;
  /** mechanical 级验证命令（level=mechanical 时必填）。 */
  command?: string;
  /** semantic 级裁决结构化 schema（宿主侧校验，本包透传）。 */
  outputSchema?: unknown;
}

/** 访谈起草得到的 goal 契约（objective + 条款集）。 */
export interface GoalContract {
  /** 目标描述（不含 Done-when 段）。 */
  objective: string;
  /** Done-when 条款集（非空）。 */
  clauses: ContractClause[];
}

/** 条款校验结果（判别联合）。 */
export type ClauseValidation =
  { ok: true; clauses: ContractClause[] } | { ok: false; errors: string[] };

// ── 宿主结构化接口（对齐官方服务形状，避免 import cordis） ─────────────────────

/** 单个问题（对齐 user-questions AskUserQuestionItem 子集）。 */
export interface HostQuestion {
  /** 问题 id（答案回显）。 */
  id: string;
  /** 问题正文。 */
  question: string;
  /** 短标题（可选）。 */
  header?: string;
  /** 选项（缺省为自由输入）。 */
  options?: { label: string; description?: string }[];
}

/** 单个答案（对齐 AskUserQuestionAnswerItem）。 */
export interface HostAnswer {
  /** 对应问题 id。 */
  id: string;
  /** 选中的选项 label。 */
  selected: string[];
  /** 自由文本答案（可选）。 */
  custom?: string;
}

/** userQuestions 服务最小型（对齐 ctx.userQuestions.ask）。 */
export interface UserQuestionsLike {
  ask(request: {
    questions: HostQuestion[];
    /** 发起 agent（工具执行上下文透传，宿主据此校验 human 交互权限）。 */
    agent?: unknown;
    signal?: { aborted: boolean };
  }): Promise<{ answers: HostAnswer[] }>;
}

/** goal 当前视图（对齐 dsh-goal GoalView 的回读子集）。 */
export interface GoalViewLike {
  id: string;
  revision: number;
  objective: string;
  phase: string;
  maxGoalRounds: number;
  roundsStarted: number;
}

/** goals 服务最小型（对齐 dsh-goal GoalService create/get 子集）。 */
export interface GoalsLike {
  /** 创建（并 armed）goal；失败抛错（如 GOAL_ALREADY_EXISTS）。 */
  create(
    agent: unknown,
    request: { objective: string; maxGoalRounds?: number },
  ): GoalViewLike;
  /** 回读当前 goal 视图（无 goal 时 undefined）。 */
  get(agent: unknown): GoalViewLike | undefined;
}

/** 工具执行上下文最小型（对齐宿主 ToolRunContext 子集）。 */
export interface ToolExecLike {
  /** 发起 agent（透传给 userQuestions.ask 与 goals.create/get）。 */
  agent?: unknown;
  signal?: { aborted: boolean };
}
