/**
 * flow-track/src/command.ts — `/flow-track` 命令面（`ctx.commands.register`, 零 TUI 改动）。
 *
 * 子命令：`on` 打开注入开关 / `off` 关闭 / `status`（缺省）查看开关与活跃流程。
 * 开关是进程内状态（`switch.ts`），重启即回到关闭。
 */

import { describeGate, describeSwitch, type FlowSwitch } from "./switch.ts";

/** 命令注册面（结构化）。 */
export interface CommandRegistrarLike {
  register(def: unknown): unknown;
}

/** 命令依赖。 */
export interface FlowCommandDeps {
  switcher: FlowSwitch;
  /** 是否有未完成阶段的流程记录（由 index 注入）。 */
  hasActive(): boolean;
}

/** 命令用法。 */
export const USAGE = "用法: /flow-track on | off | status";

/** 命令回执（宿主的文本回执形态）。 */
export interface CommandReply {
  kind: "text" | "error";
  text: string;
}

/** 开关 + 活跃流程的状态文案。 */
export function statusText(deps: FlowCommandDeps): string {
  const active = deps.hasActive();
  return `${describeSwitch(deps.switcher)}\n${describeGate(deps.switcher, active)}`;
}

/** 分派一条 `/flow-track …` 输入（`rawInput` 不含命令名本身）。 */
export function dispatchFlowCommand(
  deps: FlowCommandDeps,
  rawInput: string,
): CommandReply {
  const sub = (rawInput.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (sub === "" || sub === "status") {
    return { kind: "text", text: statusText(deps) };
  }
  if (sub === "on" || sub === "off") {
    deps.switcher.enabled = sub === "on";
    return { kind: "text", text: statusText(deps) };
  }
  return { kind: "error", text: `未知子命令「${sub}」\n${USAGE}` };
}

/** 注册 `/flow-track`；commands 服务缺席时返回 undefined。 */
export function registerFlowCommand(
  commands: CommandRegistrarLike | undefined,
  deps: FlowCommandDeps,
): (() => void) | undefined {
  if (commands === undefined || typeof commands.register !== "function") {
    return undefined;
  }
  const off = commands.register({
    definitionId: "flow-track:flow-track",
    name: "flow-track",
    description:
      "标准流程固化插件：打开 / 关闭上下文注入开关，或查看开关与活跃流程状态（on / off / status）；开关只在本进程内有效",
    input: { hint: "on | off | status" },
    handler: (invocation: { rawInput?: string } | undefined) =>
      dispatchFlowCommand(deps, invocation?.rawInput ?? ""),
  });
  return typeof off === "function" ? (off as () => void) : undefined;
}
