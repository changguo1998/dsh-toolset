/**
 * flow-track/src/stages.ts — 标准流程阶段模板（八阶段，2026-11-05 用户裁定）。
 *
 * 每阶段 = **单动作** spec（不写「首先 / 然后 / 第 n 步」，不塞实现细节），防止 task-engine 的
 * 「过细 / 越级」门禁打回；`deps` 指前序阶段（引擎只允许引用前序兄弟）。
 *
 * 提交询问点（`docs/WORKFLOW-STANDARD.md` §5 的四处）落在阶段 3 / 5 / 6 / 8 内部；
 * 阶段 7 的 human 门禁即「人工确认 / 审阅」那一次。
 */

/** 验收门禁类型（与 task-engine 的 `AcceptanceLevel` 同口径的子集）。 */
export type StageGate = "mechanical" | "human";

/** 一个阶段的模板。 */
export interface StageSpec {
  /** 阶段序号（1 起）。 */
  index: number;
  /** 阶段名（也是任务帧标题的前缀）。 */
  name: string;
  /** 单动作 spec（交给 `task_decompose` 的 `spec`）。 */
  spec: string;
  /** 验收口径（交给 `task_decompose` 的 `acceptance[].check`）。 */
  acceptance: string;
  /** 门禁类型。 */
  gate: StageGate;
  /** 前置阶段序号。 */
  deps: readonly number[];
}

/** 八阶段模板（顺序即执行顺序）。 */
export const STAGES: readonly StageSpec[] = [
  {
    index: 1,
    name: "目标",
    spec: "写清任务目标与验收口径。",
    acceptance: "追踪文档含「目标」节且写明验收判据。",
    gate: "mechanical",
    deps: [],
  },
  {
    index: 2,
    name: "调研",
    spec: "读相关代码与宿主面, 结论带来源锚点。",
    acceptance: "追踪文档含「调研」节且有 `文件:行` 级来源。",
    gate: "mechanical",
    deps: [1],
  },
  {
    index: 3,
    name: "决策",
    spec: "决策项按数字、选项按字母列候选并选定。",
    acceptance: "每个决策项写明选定字母与理由。",
    gate: "mechanical",
    deps: [2],
  },
  {
    index: 4,
    name: "规划",
    spec: "写计划改动文件清单与明确不做。",
    acceptance: "追踪文档含「计划改动文件清单」与「明确不做」。",
    gate: "mechanical",
    deps: [3],
  },
  {
    index: 5,
    name: "实现",
    spec: "按清单改动并追加实现记录。",
    acceptance: "`pnpm run check` 通过且实现记录已写。",
    gate: "mechanical",
    deps: [4],
  },
  {
    index: 6,
    name: "测试",
    spec: "跑相关 test 与 check:docs 并补「测试与证据」。",
    acceptance: "命令与输出入档。",
    gate: "mechanical",
    deps: [5],
  },
  {
    index: 7,
    name: "审查",
    spec: "交审查方审阅 diff 与效果, 结论入档。",
    acceptance: "审查方确认（人工门禁）。",
    gate: "human",
    deps: [6],
  },
  {
    index: 8,
    name: "收尾",
    spec: "归档追踪文档、清理 BACKLOG 条目并按需回写文档。",
    acceptance: "追踪文档已移动且条目已移除。",
    gate: "mechanical",
    deps: [7],
  },
];

/** 阶段名清单（建树与匹配共用）。 */
export function stageNames(): string[] {
  return STAGES.map((stage) => stage.name);
}

/** 按阶段序号取模板。 */
export function stageAt(index: number): StageSpec | undefined {
  return STAGES.find((stage) => stage.index === index);
}

/**
 * 按任务帧标题匹配阶段：标题以阶段名开头即命中（允许「决策：xxx」这类带后缀的写法）。
 */
export function stageOfTitle(title: string): StageSpec | undefined {
  return STAGES.find((stage) => title.startsWith(stage.name));
}

/** 渲染阶段模板（注入给模型；模型据此手动 `task_decompose`）。 */
export function renderStages(): string {
  const lines = [
    "[flow-track] 标准流程八阶段模板（按顺序分解, 每阶段一个帧, 不要合并或跳级）：",
  ];
  for (const stage of STAGES) {
    const deps =
      stage.deps.length === 0
        ? "无前置"
        : `前置: ${stage.deps.map((index) => stageAt(index)?.name ?? String(index)).join(" / ")}`;
    const gate =
      stage.gate === "human" ? "human 门禁（人工确认）" : "mechanical 门禁";
    lines.push(
      `${stage.index}. ${stage.name} — ${stage.spec} 验收：${stage.acceptance}（${gate}；${deps}）`,
    );
  }
  lines.push(
    "提交询问点：阶段 3 决策后 / 5 实现后 / 6 测试后 / 8 关闭后 各问一次是否提交。",
  );
  return lines.join("\n");
}
