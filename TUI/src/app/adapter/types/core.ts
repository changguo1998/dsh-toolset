// src/app/adapter/types/core.ts — 核心词汇：状态、目标、待办、审批与内容块

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

// ---------------------------------------------------------------------------
// P2 领域载荷结构面（rc.2 源码核实；宽松读取，字段缺省不抛错）
// ---------------------------------------------------------------------------

/** goal/change 的操作动词（packages/goal/goal/src/domain.ts GoalOperation） */
export type GoalOperation =
  "create" | "edit" | "pause" | "resume" | "complete" | "block" | "clear";

/** goal 自动续轮开关（GoalActivation；**进程本地**态，不进会话日志） */
export type GoalActivation = "armed" | "disarmed";

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

/** notice/tool 行 tone——4 级语义 5 色值：log 灰=进度/状态无需关注；info 蓝=需用户了解；warn 黄=可绕开的运行错误/副作用危险警示；result 级互斥：error 红=操作失败（用户输入命令的结果一律 error、须修复继续）、success 绿=重要操作成功 */
export type NoticeTone = "log" | "info" | "warn" | "error" | "success";
/** 应用层收到的归一化事件（见文件头映射表） */
/**
 * 状态列 **Agents 块**的行（BACKLOG TUI#39）：adapter 对宿主 subagents 目录的归一化结果
 * （`listDescendants` 的 depth=1 直接子代）。
 * 只读展示：label + 状态 + 短 id；异常态（宿主目录投影不完整）走 `diagnostic`。
 */
export interface AgentRowInfo {
  id: string;
  /** 展示名（宿主未给时由 adapter 兜底占位） */
  label: string;
  /** 状态语义：`running`（运行中）/ `inactive`（空闲）；缺失时回落 mode（one-shot / continuable） */
  status: string;
  /** 会话别名（session-channel；状态列 Agents 块显示名 = 别名 ?? label） */
  alias?: string;
  /** 工作内容：该会话最近一次工具调用摘要（adapter 按会话记录；无记录时省略） */
  work?: string;
  /** 异常态：宿主把该条目标为 diagnostic（投影不完整 / 不可续），reason 为宿主给出的短因 */
  diagnostic?: { reason: string };
  /**
   * 该子代理最近的输出速率（tokens/s，adapter 侧估计）。
   *
   * 用途：状态列 Agents 块**条目行自己的状态符号**按此速率闪烁（BACKLOG 条目 1 用户口径：
   * 快 → 闪得快，慢 → 闪得慢）；缺省 = 未知速率，按基础速率闪。
   */
  tps?: number;
}
