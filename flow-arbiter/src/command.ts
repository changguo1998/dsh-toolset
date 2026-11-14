/**
 * flow-arbiter/src/command.ts — `/flow-arbiter` 命令面（`ctx.commands.register`，零 TUI 改动）。
 *
 * 子命令：`status`（缺省）查看当前选择与登记；`select <id>` 选中（顶替旧选择）；`off` 取消。
 * 与模型侧 `flow_select` 共用同一份会话级状态（按命令调用方的会话判定）。
 */

import type { FlowArbiterState } from "./state.ts";

/** 命令注册面（结构化）。 */
export interface CommandRegistrarLike {
  register(def: unknown): unknown;
}

/** 命令依赖。 */
export interface FlowArbiterCommandDeps {
  state: FlowArbiterState;
  /** 命令调用方的会话 id（宿主回执里带 agent 时由 index 注入）。 */
  sessionOf(invocation: unknown): string | undefined;
}

/** 命令用法。 */
export const USAGE = "用法: /flow-arbiter status | select <流程 id> | off";

/** 命令回执（宿主 `CommandResult` 形态）。 */
export interface CommandReply {
  kind: "success" | "error";
  text: string;
}

/** 状态文案。 */
export function statusText(
  state: FlowArbiterState,
  sessionId: string | undefined,
): string {
  const flows = state
    .list()
    .map((flow) => `${flow.id}（${flow.name}，入口 ${flow.entry}）`)
    .join(" / ");
  if (sessionId === undefined) {
    return `登记：${flows}\n当前选择：无法判定会话（命令调用缺会话 id）`;
  }
  const current = state.current(sessionId);
  return `登记：${flows}\n当前选择：${
    current === undefined
      ? "未选中（任何流程入口都会被拒）"
      : `${current.id}（${current.name}）`
  }`;
}

/** 分派一条 `/flow-arbiter …` 输入（`rawInput` 不含命令名本身）。 */
export function dispatchArbiterCommand(
  deps: FlowArbiterCommandDeps,
  rawInput: string,
  invocation?: unknown,
): CommandReply {
  const parts = rawInput.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const sessionId = deps.sessionOf(invocation);
  if (sub === "" || sub === "status") {
    return { kind: "success", text: statusText(deps.state, sessionId) };
  }
  if (sessionId === undefined) {
    return {
      kind: "error",
      text: `无法判定会话归属，无法改流程选择\n${USAGE}`,
    };
  }
  if (sub === "off") {
    const had = deps.state.clear(sessionId);
    return {
      kind: "success",
      text: `${had ? "已取消流程选择" : "本来就没有选择"}\n${statusText(deps.state, sessionId)}`,
    };
  }
  if (sub === "select") {
    const flowId = parts[1] ?? "";
    if (flowId === "") {
      return { kind: "error", text: `select 需要流程 id\n${USAGE}` };
    }
    const result = deps.state.select(sessionId, flowId);
    if (!result.ok) {
      return { kind: "error", text: `${result.message}\n${USAGE}` };
    }
    const replaced =
      result.replaced === undefined ? "" : `（顶替了 ${result.replaced.id}）`;
    return {
      kind: "success",
      text: `已选中 ${result.flow.id}（${result.flow.name}）${replaced}\n${statusText(deps.state, sessionId)}`,
    };
  }
  return { kind: "error", text: `未知子命令「${sub}」\n${USAGE}` };
}

/** 注册 `/flow-arbiter`；commands 服务缺席时返回 undefined。 */
export function registerArbiterCommand(
  commands: CommandRegistrarLike | undefined,
  deps: FlowArbiterCommandDeps,
): (() => void) | undefined {
  if (commands === undefined || typeof commands.register !== "function") {
    return undefined;
  }
  const off = commands.register({
    definitionId: "flow-arbiter:flow-arbiter",
    name: "flow-arbiter",
    description:
      "流程选择仲裁：选中 / 取消本会话要用的流程，或查看登记与当前选择（status / select <id> / off）；选择只在内存",
    input: { hint: "status | select <id> | off" },
    handler: (invocation: { rawInput?: string } | undefined) =>
      dispatchArbiterCommand(deps, invocation?.rawInput ?? "", invocation),
  });
  return typeof off === "function" ? (off as () => void) : undefined;
}
