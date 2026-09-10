// src/types.ts — 任务树引擎领域类型
//
// 契约对齐 AGENT-ARCHITECTURE-ANALOGY.md §17：任务 = 契约（spec + acceptance 三级）。
// 帧（Frame）是活动记录：只携续体所需最小上下文（§13.3）。

export type FrameId = string;

export type AcceptanceLevel = "mechanical" | "semantic" | "human";

export interface Acceptance {
  id: string;
  check: string;
  level: AcceptanceLevel;
  /** mechanical 级验收命令（退出码 0 = 通过） */
  command?: string;
}

export type FrameStatus = "pending" | "active" | "done" | "failed";

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
    }
  | {
      type: "plan/frame-rejected";
      frame: FrameId;
      reason: string;
      feedback: string;
    }
  | { type: "plan/frame-completed"; frame: FrameId }
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
  children: NestedTaskItem[];
}
