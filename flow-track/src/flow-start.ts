/**
 * flow-track/src/flow-start.ts — 流程入口工具 `flow_start`（决策项 5 / 4.0）。
 *
 * 模型只确认「用标准流程」，入口内部按流程定义一次性调 task-engine 的**编程服务面**
 * `composeFromNodes(parentId, nodes)` 建整棵节点（走 task-engine 既有双门禁），模型不必逐节点
 * `task_decompose`。建树之后节点推进 / 校验 / 验收 / 推送全部由 task-engine 接管，本包不再介入
 * 执行期（决策项 4.0）。
 *
 * 仲裁（决策项 7 / 8）尚未就绪：本阶段入口全放行；阶段 4 由 flow-arbiter 在 pre-execute 拦截。
 */

import { FLOW_ID, FLOW_NODES, FLOW_NAME } from "./stages.ts";
import { TOOL_OUTPUT, type ToolDef } from "./tools.ts";

/** task-engine 子帧声明（结构子集；本包不依赖 task-engine 包，按服务面结构取）。 */
export interface FlowNodeInput {
  id: string;
  title: string;
  spec: string;
  acceptance: { id: string; check: string; level: string }[];
  needDecompose: boolean;
  coverage: Record<string, string[]>;
  deps?: string[];
  enforceOrder?: boolean;
}

/** task-engine 建树结果（`DecomposeResult` 的结构子集）。 */
export interface ComposeResultLike {
  ok: boolean;
  accepted?: boolean;
  next?: string | null;
  feedback?: string;
}

/** 建树服务面（`taskEngine.composeFromNodes`；缺席时工具返回可读错误，不假建树）。 */
export type ComposeFace = (
  parentId: string | undefined,
  nodes: FlowNodeInput[],
) => Promise<ComposeResultLike>;

/** 入口工具依赖。 */
export interface FlowStartDeps {
  /**
   * 取建树服务面（**每次调用现读**：装配顺序不保证 task-engine 先 provide，
   * 取不到时工具返回可读错误，不假建树）。
   */
  compose(): ComposeFace | undefined;
  /** 帧 id 前缀（每次建树一个，跨轮唯一；同 id 重复建树会被 task-engine 拒绝）。 */
  prefix(): string;
}

/**
 * 按流程定义生成建树入参：帧 id = `<前缀>-s<序号>`, 标题 = 阶段名（`flow_status` 靠标题认阶段），
 * 前置 = 前一个节点（同父兄弟链），顺序强制随节点声明。
 */
export function buildFlowNodes(prefix: string): FlowNodeInput[] {
  return FLOW_NODES.map((node) => {
    const id = `${prefix}-s${node.index}`;
    const prev = node.index === 1 ? undefined : `${prefix}-s${node.index - 1}`;
    return {
      id,
      title: node.name,
      spec: node.spec,
      acceptance: [{ ...node.acceptance }],
      needDecompose: node.needDecompose,
      coverage: {},
      ...(prev === undefined ? {} : { deps: [prev] }),
      ...(node.enforceOrder ? { enforceOrder: true } : {}),
    };
  });
}

/** 流程入口工具。 */
export function flowStartTool(deps: FlowStartDeps): ToolDef {
  return {
    name: "flow_start",
    description:
      "用途: 按标准流程定义一次性建出八阶段任务树（目标 / 调研 / 决策 / 规划 / 实现 / 测试 / 审查 / 收尾）。\n" +
      "用法: 可选 parent_id（缺省建在当轮根下）；建好后按 task 推送的当前节点推进（task_implement / task_stop）。\n" +
      "效果: 返回 flow / nodes（八个帧 id）/ accepted / next；节点顺序强制，前序未完成时 task-engine 拒绝越序操作。\n" +
      "边界: 只建树, 不写流程记录（推进用 flow_record）；树里的节点内容由流程定义给出, 不要再手动 task_decompose。\n" +
      "相关: flow_record、flow_status、task_status、task_implement、task_stop。",
    summary:
      "用途: 按标准流程定义一次性建出八阶段任务树; 完整说明与参数 schema 经 consult_tools 查询。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        parent_id: {
          type: "string",
          description: "挂载点帧 id（缺省建在当轮根下）",
        },
      },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      const raw = args["parent_id"];
      const parentId =
        typeof raw === "string" && raw.trim().length > 0
          ? raw.trim()
          : undefined;
      const compose = deps.compose();
      if (compose === undefined) {
        return {
          ok: false,
          error: "task_engine_unavailable",
          message:
            "task-engine 未暴露编程建树入口（composeFromNodes）：请确认 task-engine 已挂载且版本支持该服务面",
        };
      }
      const nodes = buildFlowNodes(deps.prefix());
      let result: ComposeResultLike;
      try {
        result = await compose(parentId, nodes);
      } catch (error) {
        return {
          ok: false,
          error: "compose_failed",
          message: `建树失败：${String(error)}`,
        };
      }
      if (!result.ok) {
        return {
          ok: false,
          error: "rejected",
          flow: FLOW_ID,
          accepted: result.accepted ?? false,
          message: result.feedback ?? "task-engine 拒绝了本次建树（详见反馈）",
        };
      }
      return {
        ok: true,
        flow: FLOW_ID,
        flowName: FLOW_NAME,
        parentId: parentId ?? "root",
        accepted: result.accepted ?? true,
        next: result.next ?? null,
        nodes: nodes.map((node) => node.id),
      };
    },
  };
}
