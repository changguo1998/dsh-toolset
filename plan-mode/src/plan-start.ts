/**
 * plan-mode/src/plan-start.ts — 流程入口工具 `plan_start`（决策项 5 / 6）。
 *
 * 模型只确认「用 plan 模式」，入口内部按三段流程定义一次性调 task-engine 的编程服务面
 * `composeFromNodes(parentId, nodes)` 建整棵节点（走 task-engine 既有双门禁），模型不必逐节点
 * `task_decompose`；建树之后，节点内部细化、推进、验收、推送全部由 task-engine 接管。
 *
 * 仲裁（决策项 7 / 8）尚未就绪：本阶段入口全放行；阶段 4 由 flow-arbiter 在 pre-execute 拦截。
 */

import { PLAN_ID, PLAN_NAME, PLAN_NODES } from "./stages.ts";

/** task-engine 子帧声明（结构子集；本包不依赖 task-engine 包，按服务面结构取）。 */
export interface PlanNodeInput {
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
export interface PlanComposeResult {
  ok: boolean;
  accepted?: boolean;
  next?: string | null;
  feedback?: string;
}

/** 建树服务面（`taskEngine.composeFromNodes`）。 */
export type PlanComposeFace = (
  parentId: string | undefined,
  nodes: PlanNodeInput[],
) => Promise<PlanComposeResult>;

/** 工具定义（宿主 `tools.register` 的最小形态；本包只有这一个工具）。 */
export interface PlanToolDef {
  name: string;
  description: string;
  summary?: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  output: {
    schema: Record<string, unknown>;
    render: (
      args: unknown,
      value: unknown,
    ) => Array<{ type: string; text: string }>;
  };
}

/** 入口工具依赖。 */
export interface PlanStartDeps {
  /** 取建树服务面（每次调用现读：装配顺序不保证 task-engine 先 provide）。 */
  compose(): PlanComposeFace | undefined;
  /** 帧 id 前缀（每次建树一个，跨轮唯一）。 */
  prefix(): string;
  /** 建树成功后的钩子（阶段 1）：由调用方串起会话映射与权限预设切换。 */
  onStarted?(input: {
    sessionId: string;
    session?: unknown;
    frames: readonly string[];
  }): Promise<{ presetSwitched: boolean; presetNote?: string }>;
}

/** 按流程定义生成建树入参：帧 id = `<前缀>-s<序号>`，标题 = 阶段名，前置 = 前一个节点。 */
export function buildPlanNodes(prefix: string): PlanNodeInput[] {
  return PLAN_NODES.map((node) => {
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

/** 输出面（JSON 文本，与本仓其它流程工具同口径）。 */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 流程入口工具。 */
export function planStartTool(deps: PlanStartDeps): PlanToolDef {
  return {
    name: "plan_start",
    description:
      "用途: 按 plan 模式三段流程（探索 / 计划 / 实施）一次性建出任务树。\n" +
      "用法: 可选 parent_id（缺省建在当轮根下）；三段各可再拆，段内细化用 task_decompose，段完成用 task_stop。\n" +
      "效果: 返回 flow / nodes（三个帧 id）/ accepted / next；节点顺序强制，前序未完成时 task-engine 拒绝越序操作。\n" +
      "只读: 进入后探索与计划段只读，计划确认后自动恢复。\n" +
      "边界: 只建树, 不写流程记录；「计划」段是人工门禁（审批通过才进实施）。\n" +
      "相关: task_decompose、task_status、task_implement、task_stop。",
    summary:
      "用途: 按 plan 三段流程一次性建出任务树; 完整说明与参数 schema 经 consult_tools 查询。",
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
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
    async execute(args, exec) {
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
      const nodes = buildPlanNodes(deps.prefix());
      let result: PlanComposeResult;
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
          flow: PLAN_ID,
          accepted: result.accepted ?? false,
          message: result.feedback ?? "task-engine 拒绝了本次建树（详见反馈）",
        };
      }
      const sessionLike = exec as
        | { agent?: { session?: { id?: string } }; session?: { id?: string } }
        | undefined;
      const session = sessionLike?.agent?.session ?? sessionLike?.session;
      const sessionId = typeof session?.id === "string" ? session.id : null;
      const frames = nodes.map((node) => node.id);
      if (deps.onStarted === undefined || sessionId === null) {
        return {
          ok: true,
          flow: PLAN_ID,
          flowName: PLAN_NAME,
          parentId: parentId ?? "root",
          accepted: result.accepted ?? true,
          next: result.next ?? null,
          nodes: frames,
          sessionId: null,
          presetSwitched: false,
          presetNote: "拿不到会话，权限面未切换",
        };
      }
      let presetSwitched = false;
      let presetNote: string | undefined;
      try {
        const hook = await deps.onStarted({ sessionId, session, frames });
        presetSwitched = hook.presetSwitched;
        presetNote = hook.presetNote;
      } catch (error) {
        presetNote = `权限面处理失败：${String(error)}`;
      }
      return {
        ok: true,
        flow: PLAN_ID,
        flowName: PLAN_NAME,
        parentId: parentId ?? "root",
        accepted: result.accepted ?? true,
        next: result.next ?? null,
        nodes: frames,
        sessionId,
        presetSwitched,
        ...(presetNote === undefined ? {} : { presetNote }),
      };
    },
  };
}
