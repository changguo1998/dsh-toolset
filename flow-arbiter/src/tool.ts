/**
 * flow-arbiter/src/tool.ts — 模型侧选择工具 `flow_select`（选中 / 取消 / 查看）。
 *
 * 一个工具三种用法：给 `flow` → 选中（顶替同会话旧选择）；给 `-` / `off` → 取消；
 * 不给 → 报当前选择与全部登记。工具**恒注册**，选中状态只改内存里的放行规则（决策项 9① / ③）。
 */

import type { FlowArbiterState, FlowRegistration } from "./state.ts";

/** 工具定义（宿主 `tools.register` 的最小形态）。 */
export interface ToolDef {
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

/** 取消选择的别名（大小写不敏感）。 */
const CLEAR_WORDS = ["", "-", "off", "none"];

/** 从宿主 `exec` 取调用方会话 id（`agent.session.id`，缺省退回 `session.id`）。 */
export function callerSessionId(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: unknown } } | undefined)?.agent;
  const direct = (exec as { session?: unknown } | undefined)?.session;
  const session = (agent?.session ?? direct) as { id?: unknown } | undefined;
  const id = session?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** 登记的公共视图（回执里用，避免把内部对象原样透出）。 */
function flowView(flow: FlowRegistration | undefined): Record<string, unknown> {
  return flow === undefined
    ? { flow: null }
    : { flow: { id: flow.id, name: flow.name, entry: flow.entry } };
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 选择工具。 */
export function flowSelectTool(state: FlowArbiterState): ToolDef {
  return {
    name: "flow_select",
    description:
      "用途: 选中 / 取消本会话要用的流程（同一会话同一时刻只放行一个流程的入口工具）。\n" +
      "用法: 给 flow = 流程 id 选中（顶替旧选择）；给 flow = - 取消；不给则查看当前选择与全部登记。\n" +
      "效果: 只改本会话的放行规则（进程内内存, 不落盘）；未选中的流程入口（如 flow_start / plan_start）在执行前被拒。\n" +
      "边界: 不建树、不改任务树、不改工具面（工具恒注册）；切换流程不会破坏上下文缓存, 建树才会。\n" +
      "相关: flow_start、plan_start、task_status。",
    summary:
      "用途: 选中 / 取消本会话要用的流程（同一会话只放行一个入口）; 完整说明与参数 schema 经 consult_tools 查询。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        flow: {
          type: "string",
          description:
            "流程 id（standard / plan …）；- 表示取消；不给表示查看当前选择",
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
      const sessionId = callerSessionId(exec);
      const flows = state.list().map((flow) => ({
        id: flow.id,
        name: flow.name,
        entry: flow.entry,
      }));
      const raw = args["flow"];
      const requested = typeof raw === "string" ? raw.trim() : undefined;
      // 不给 flow → 只看状态
      if (raw === undefined) {
        return {
          ok: true,
          sessionId: sessionId ?? null,
          ...flowView(
            sessionId === undefined ? undefined : state.current(sessionId),
          ),
          flows,
        };
      }
      if (sessionId === undefined) {
        return {
          ok: false,
          error: "no_session",
          message:
            "无法判定会话归属：请在会话回合内调用（工具执行缺 agent.session.id）",
        };
      }
      if (CLEAR_WORDS.includes((requested ?? "").toLowerCase())) {
        const had = state.clear(sessionId);
        return { ok: true, sessionId, flow: null, cleared: had, flows };
      }
      const result = state.select(sessionId, requested ?? "");
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          message: result.message,
          flows,
        };
      }
      return {
        ok: true,
        sessionId,
        ...flowView(result.flow),
        ...(result.replaced === undefined
          ? {}
          : { replaced: result.replaced.id }),
        flows,
      };
    },
  };
}
