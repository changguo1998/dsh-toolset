/**
 * flow-track/src/stages.ts — 标准流程八阶段**流程定义**（决策项 4.4：不再作注入模板）。
 *
 * 一份流程定义 = 节点数组：每个节点给出 id 后缀、标题、spec、验收、粒度、前置与顺序强制声明。
 * 建树走 task-engine 的编程服务面（`composeFromNodes`，见 `flow-start.ts`），节点推进 / 校验 /
 * 验收 / 推送全部由 task-engine 接管，本包不再渲染阶段模板。
 *
 * spec 是**单动作**句子（不写「首先 / 然后 / 第 n 步」、不含指令列表、不点文件名），
 * 才能过 task-engine 的粒度门禁（过粗 / 过细 / 越级三条启发）；验收用语义级（audit run 裁决
 * spec 里写明的判据），审查阶段用 human 门禁（人工确认）。
 */

/** 验收条目（与 task-engine `Acceptance` 同口径的结构子集）。 */
export interface FlowAcceptance {
  id: string;
  check: string;
  level: "semantic" | "human";
}

/** 一个流程节点（建树时转成 task-engine 的子帧声明）。 */
export interface FlowNodeSpec {
  /** 阶段序号（1 起；也是帧 id 后缀与推进顺序）。 */
  index: number;
  /** 阶段名（帧标题；也是 `flow_record` 的阶段枚举）。 */
  name: string;
  /** 单动作 spec（推给模型的目标）。 */
  spec: string;
  /** 验收条目（语义级 / 人工级，无机械命令）。 */
  acceptance: FlowAcceptance;
  /** 是否需要再拆（八阶段各自可直接落地，缺省叶子）。 */
  needDecompose: boolean;
  /** 前置节点序号（1 起；建树时转成前序兄弟 id）。 */
  deps: readonly number[];
  /** 顺序强制声明（流程定义级：本流程的兄弟序列按序推进）。 */
  enforceOrder: boolean;
}

/** 流程标识（仲裁插件按它登记与选中；阶段 4 接入）。 */
export const FLOW_ID = "standard";

/** 流程显示名。 */
export const FLOW_NAME = "标准流程八阶段";

/** 八阶段定义（顺序即执行顺序）。 */
export const FLOW_NODES: readonly FlowNodeSpec[] = [
  {
    index: 1,
    name: "目标",
    spec: "写清任务目标与验收口径。",
    acceptance: {
      id: "q-s1",
      check: "追踪文档含「目标」节且写明验收判据。",
      level: "semantic",
    },
    needDecompose: false,
    deps: [],
    enforceOrder: true,
  },
  {
    index: 2,
    name: "调研",
    spec: "读相关代码与宿主面并给出带来源的结论。",
    acceptance: {
      id: "q-s2",
      check: "追踪文档含「调研」节且有文件行号级来源。",
      level: "semantic",
    },
    needDecompose: false,
    deps: [1],
    enforceOrder: true,
  },
  {
    index: 3,
    name: "决策",
    spec: "按数字列决策项并按字母选定候选。",
    acceptance: {
      id: "q-s3",
      check: "每个决策项写明选定字母与理由。",
      level: "semantic",
    },
    needDecompose: false,
    deps: [2],
    enforceOrder: true,
  },
  {
    index: 4,
    name: "规划",
    spec: "写出计划改动文件清单与明确不做。",
    acceptance: {
      id: "q-s4",
      check: "追踪文档含「计划改动文件清单」与「明确不做」两节。",
      level: "semantic",
    },
    needDecompose: false,
    deps: [3],
    enforceOrder: true,
  },
  {
    index: 5,
    name: "实现",
    spec: "按清单改动并追加实现记录。",
    acceptance: {
      id: "q-s5",
      check: "类型检查通过且实现记录已写进追踪文档。",
      level: "semantic",
    },
    needDecompose: false,
    deps: [4],
    enforceOrder: true,
  },
  {
    index: 6,
    name: "测试",
    spec: "跑相关测试并补测试与证据一节。",
    acceptance: {
      id: "q-s6",
      check: "测试命令与输出已入档。",
      level: "semantic",
    },
    needDecompose: false,
    deps: [5],
    enforceOrder: true,
  },
  {
    index: 7,
    name: "审查",
    spec: "交审查方审阅 diff 与效果并记录结论。",
    acceptance: {
      id: "q-s7",
      check: "审查方确认（人工门禁）。",
      level: "human",
    },
    needDecompose: false,
    deps: [6],
    enforceOrder: true,
  },
  {
    index: 8,
    name: "收尾",
    spec: "归档追踪文档并清理 BACKLOG 条目。",
    acceptance: {
      id: "q-s8",
      check: "追踪文档已归档且条目已清理。",
      level: "semantic",
    },
    needDecompose: false,
    deps: [7],
    enforceOrder: true,
  },
];

/** 阶段名清单（记录顺序策略与工具枚举共用）。 */
export function stageNames(): string[] {
  return FLOW_NODES.map((node) => node.name);
}

/** 按阶段序号取节点。 */
export function stageAt(index: number): FlowNodeSpec | undefined {
  return FLOW_NODES.find((node) => node.index === index);
}

/** 阶段名在流程里的下标（不在表内返回 -1）。 */
export function stageIndex(name: string): number {
  return FLOW_NODES.findIndex((node) => node.name === name);
}

/**
 * 按任务帧标题匹配节点：标题以阶段名开头即命中（允许「决策：xxx」这类带后缀的写法）。
 */
export function stageOfTitle(title: string): FlowNodeSpec | undefined {
  return FLOW_NODES.find((node) => title.startsWith(node.name));
}
