/**
 * plan-mode/src/stages.ts — plan 三段**流程定义**（决策项 6：独立流程定义插件，与 flow-track 平级）。
 *
 * 探索 → 计划 → 实施：三段都是可再拆的复杂任务（`needDecompose: true`），节点内部细化仍走
 * task-engine 的 `task_decompose`；建树走编程服务面（`composeFromNodes`，见 `plan-start.ts`），
 * 建树之后节点推进 / 校验 / 验收 / 推送全部由 task-engine 接管。
 *
 * 门禁：探索 / 实施用语义级（audit run 按 check 裁决），计划用 human——确认计划后才进入实施，
 * 这是 plan 模式最关键的人工闸门。
 */

/** 验收条目（与 task-engine `Acceptance` 同口径的结构子集）。 */
export interface PlanAcceptance {
  id: string;
  check: string;
  level: "semantic" | "human";
}

/** 一个流程节点（建树时转成 task-engine 的子帧声明）。 */
export interface PlanNodeSpec {
  /** 阶段序号（1 起；也是帧 id 后缀与推进顺序）。 */
  index: number;
  /** 阶段名（帧标题）。 */
  name: string;
  /** 该段落要做的事（帧 spec，推给模型的目标）。 */
  spec: string;
  /** 验收条目（语义级 / 人工级）。 */
  acceptance: PlanAcceptance;
  /** 是否可再拆（三段都是复杂任务）。 */
  needDecompose: boolean;
  /** 前置节点序号（1 起；建树时转成前序兄弟 id）。 */
  deps: readonly number[];
  /** 顺序强制声明（流程定义级）。 */
  enforceOrder: boolean;
}

/** 流程标识（仲裁插件按它登记与选中；阶段 4 接入）。 */
export const PLAN_ID = "plan";

/** 流程显示名。 */
export const PLAN_NAME = "plan 模式三段";

/** 三段定义（顺序即执行顺序）。 */
export const PLAN_NODES: readonly PlanNodeSpec[] = [
  {
    index: 1,
    name: "探索",
    spec: "摸清现状与约束并列出候选方案。",
    acceptance: {
      id: "q-p1",
      check: "探索结论写出现状、约束与候选方案的取舍。",
      level: "semantic",
    },
    needDecompose: true,
    deps: [],
    enforceOrder: true,
  },
  {
    index: 2,
    name: "计划",
    spec: "给出改动清单与验收口径。",
    acceptance: {
      id: "q-p2",
      check: "人工确认计划后再进入实施（plan 模式的人工闸门）。",
      level: "human",
    },
    needDecompose: true,
    deps: [1],
    enforceOrder: true,
  },
  {
    index: 3,
    name: "实施",
    spec: "按计划改动并跑验证。",
    acceptance: {
      id: "q-p3",
      check: "改动与已确认的计划一致，且验证命令通过。",
      level: "semantic",
    },
    needDecompose: true,
    deps: [2],
    enforceOrder: true,
  },
];

/** 阶段名清单。 */
export function planStageNames(): string[] {
  return PLAN_NODES.map((node) => node.name);
}

/** 按阶段序号取节点。 */
export function planStageAt(index: number): PlanNodeSpec | undefined {
  return PLAN_NODES.find((node) => node.index === index);
}
