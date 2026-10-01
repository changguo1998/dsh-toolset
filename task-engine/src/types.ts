// src/types.ts — 任务树引擎领域类型
//
// 契约对齐 docs/host/AGENT-ARCHITECTURE-ANALOGY.md §17：任务 = 契约（spec + acceptance 三级）。
// 帧（Frame）是活动记录：只携续体所需最小上下文（§13.3）。

export type FrameId = string;

export type AcceptanceLevel = "mechanical" | "semantic" | "human";

export interface Acceptance {
  id: string;
  check: string;
  level: AcceptanceLevel;
  /** mechanical 级验收命令（退出码 0 = 通过） */
  command?: string;
  /** semantic 级：audit run 结构化裁决的 outputSchema（JSON Schema，宿主校验，§16.2） */
  outputSchema?: unknown;
}

export type FrameStatus = "pending" | "active" | "done" | "failed";

/**
 * 叶子任务的执行后端（BACKLOG「task-engine 执行扩展」①）：
 * `model` = 本会话执行（缺省语义，等价于模型自己调 `task_implement`）；
 * `subagent` / `workflow` / `command` = 由引擎发起的独立执行面（引擎只做发起 / 证据回填 / 验收）。
 */
export type ExecutorKind = "model" | "subagent" | "workflow" | "command";

/** executor 声明：由模板或叶子显式声明，**引擎不替模型生成脚本**（README「边界与外包」）。 */
export interface ExecutorSpec {
  kind: ExecutorKind;
  /** 模型覆盖（`subagent` 后端用；缺省随宿主 `agentDefaultModel` 的当前选择） */
  model?: { provider: string; model: string };
  /** 预算声明（②）：后端自报 / 事后 `tokenMeter` 计量的 token 上限；超限只**标注**不打回 */
  budget?: { maxTokens?: number };
  /** `subagent`：提示词（缺省由引擎按 frame spec + 验收清单拼装） */
  prompt?: string;
  /** `workflow`：编排脚本（宿主 workflow 词汇，引擎不生成） */
  script?: string;
  /** `workflow`：脚本 meta（`WorkflowMeta` 形状，原样透传宿主） */
  meta?: Record<string, unknown>;
  /** `command`：命令（`/bin/sh -c`；退出码非 0 视为执行失败） */
  command?: string;
  /** 工作目录（`command` / `subagent` 透传；缺省继承当前会话 cwd） */
  cwd?: string;
}

/** decompose 参数中的子任务描述（模型提议，经门禁裁决后才挂树） */
export interface ChildSpec {
  id: FrameId;
  title: string;
  spec: string;
  acceptance: Acceptance[];
  /** false = 叶子，允许 implement；true = 仍需再拆 */
  needDecompose: boolean;
  /** coverage 映射：父验收条目 id → 覆盖它的子任务 id 列表（§17.2 覆盖完备） */
  coverage: Record<string, FrameId[]>;
  /** 前置传递（§17.2 顺序依赖显式化）：只允许引用前序兄弟 id */
  deps?: FrameId[];
  /** 叶子执行后端声明（仅叶子合法，门禁校验；缺省 = model 语义） */
  executor?: ExecutorSpec;
}

/** 树上的帧（物化视图节点） */
export interface Frame {
  id: FrameId;
  parentId: FrameId | null;
  order: number;
  title: string;
  spec: string;
  acceptance: Acceptance[];
  needDecompose: boolean;
  status: FrameStatus;
  children: FrameId[];
  /** implement 产出（叶子） */
  result?: string;
  /** 打回重试计数（decompose 拒绝与验收失败共用；>= maxRetries 置 failed） */
  retryCount: number;
  /** 最近一次打回反馈（带反馈重试） */
  feedback?: string;
  /** 叶子执行后端声明（树上种子字段；缺省 = model 语义） */
  executor?: ExecutorSpec;
}

/** step 级裁决（BACKLOG #5）：本步是否通过 + 建议下一步帧 + 打回反馈 */
export interface StepVerdict {
  accepted: boolean;
  /** 建议下一步（就绪池首个候选帧 id）；null = 树完成或无就绪 */
  next: FrameId | null;
  /** 打回反馈（accepted=false 时） */
  feedback?: string;
}

/** 帧事件载荷（事件溯源，§15.1） */
export type PlanEvent =
  | {
      type: "plan/root-created";
      frame: Omit<Frame, "status" | "children" | "retryCount">;
    }
  | { type: "plan/node-expanded"; parent: FrameId; children: ChildSpec[] }
  | { type: "plan/frame-activated"; frame: FrameId }
  | { type: "plan/frame-implemented"; frame: FrameId; result: string }
  | {
      type: "plan/acceptance-verdict";
      frame: FrameId;
      acceptance: string;
      level: AcceptanceLevel;
      pass: boolean;
      evidence?: string;
      /** semantic 级：audit run 的 outputSchema 结构化裁决（宿主校验） */
      structured?: unknown;
    }
  | {
      type: "plan/frame-rejected";
      frame: FrameId;
      reason: string;
      feedback: string;
    }
  | { type: "plan/frame-completed"; frame: FrameId }
  | {
      /** step 级裁决（BACKLOG #5）：事件流携带 accepted/next，供宿主/审计消费 */
      type: "plan/step-verdict";
      frame: FrameId;
      accepted: boolean;
      next: FrameId | null;
      feedback?: string;
    }
  | {
      /** 引擎发起 executor 的执行记录（① 发起 / ② 计量；证据全文走 `plan/frame-implemented`） */
      type: "plan/frame-executed";
      frame: FrameId;
      executor: ExecutorKind;
      /** 实际使用的模型（`provider/model`；未覆盖时为空串 = 随宿主默认） */
      model?: string;
      /** 事后计量 / 后端自报的 token 用量 */
      tokens?: number;
      /** 是否超出声明的 `budget.maxTokens`（只标注，不据此打回） */
      overBudget?: boolean;
      /** 结构化产出（workflow `value` 为对象时原样记录；供审计 / 下游消费） */
      structured?: unknown;
      /** 证据摘要（截断；不含全文） */
      evidence?: string;
      /** 是否可重试（false = 声明 / 环境问题：不打回、不计重试、不改帧状态） */
      retryable?: boolean;
    }
  | {
      /** abort 路径（turn/end reason=aborted）：在途帧回收为 pending，不增重试计数 */
      type: "plan/frame-interrupted";
      frame: FrameId;
      reason?: string;
    }
  | { type: "plan/frame-failed"; frame: FrameId };

/** 带序号的持久化事件 */
export type LoggedPlanEvent = PlanEvent & { seq: number; time: number };

/** 物化出的任务树视图：扁平帧表 + 根 id */
export interface TaskTree {
  rootId: FrameId;
  frames: Map<FrameId, Frame>;
}

/** 嵌套任务列表项（parent_id + order，先序展开，§14.1） */
export interface NestedTaskItem {
  id: FrameId;
  parentId: FrameId | null;
  order: number;
  title: string;
  status: FrameStatus;
  needDecompose: boolean;
  /** 叶子执行后端（未声明时不带此字段；供模型 / 展示层判断该叶子该走哪条路） */
  executorKind?: ExecutorKind;
  children: NestedTaskItem[];
}
