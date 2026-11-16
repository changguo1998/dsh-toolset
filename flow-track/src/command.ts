/**
 * flow-track/src/command.ts — `/flow-track` 命令面（`ctx.commands.register`，零 TUI 改动）。
 *
 * 子命令：`status`（无参缺省）查看注入状态——配置、本会话选中的流程、是否有未完成流程记录。
 * 流程激活由 flow-arbiter 的选中（`/flow-arbiter select <id>`）与配置 `enabled` 共同决定；
 * 2026-11-17 起本命令不再提供开关（`/flow-track on|off` 已随进程级开关一并移除）。
 */

/** 命令注册面（结构化）。 */
export interface CommandRegistrarLike {
  register(def: unknown): unknown;
}

/** 命令依赖。 */
export interface FlowCommandDeps {
  /** 配置 `enabled`（`resolveConfig`；false 时注入恒关）。 */
  configEnabled: boolean;
  /** 本会话当前选中的流程（`flowArbiter.current(sessionId)` 归一；无会话 / 未选中 → undefined）。 */
  selected(
    sessionId: string | undefined,
  ): { id: string; name: string } | undefined;
  /** 是否有未完成阶段的流程记录（由 index 注入）。 */
  hasActive(): boolean;
  /** 命令调用方的会话 id（宿主回执里带 agent 时由 index 注入）。 */
  sessionOf(invocation: unknown): string | undefined;
}

/** 命令用法。 */
export const USAGE = "用法: /flow-track status";

/** 命令回执（宿主 `CommandResult` 形态：`success` / `error`）。 */
export interface CommandReply {
  kind: "success" | "error";
  text: string;
}

/** 配置 + 选中 + 活跃记录的注入状态文案。 */
export function statusText(
  deps: FlowCommandDeps,
  sessionId: string | undefined,
): string {
  const selected = deps.selected(sessionId);
  const gate = !deps.configEnabled
    ? "不会注入：配置 enabled 关闭"
    : selected === undefined
      ? "不会注入：本会话未选中流程（/flow-arbiter select <id> 选中）"
      : deps.hasActive()
        ? "会注入：配置开启且本会话已选中流程且有未完成记录"
        : "不会注入：没有未完成阶段的流程记录";
  return [
    `flow-track 注入：${deps.configEnabled ? "配置开启" : "配置关闭"}`,
    selected === undefined
      ? "本会话流程：未选中（/flow-arbiter status 查看）"
      : `本会话流程：已选中 ${selected.id}（${selected.name}）`,
    gate,
  ].join("\n");
}

/** 分派一条 `/flow-track …` 输入（`rawInput` 不含命令名本身；仅 status）。 */
export function dispatchFlowCommand(
  deps: FlowCommandDeps,
  rawInput: string,
  invocation?: unknown,
): CommandReply {
  const sub = rawInput.trim().split(/\s+/)[0] ?? "";
  if (sub !== "" && sub.toLowerCase() !== "status") {
    return { kind: "error", text: `未知子命令「${sub}」\n${USAGE}` };
  }
  return {
    kind: "success",
    text: statusText(deps, deps.sessionOf(invocation)),
  };
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
      "标准流程注入状态查看（status；激活由配置 enabled 与 flow-arbiter 选中的流程共同决定，本命令不提供开关）",
    input: { hint: "status" },
    handler: (invocation: { rawInput?: string } | undefined) =>
      dispatchFlowCommand(deps, invocation?.rawInput ?? "", invocation),
  });
  return typeof off === "function" ? (off as () => void) : undefined;
}
