/**
 * flow-track/src/switch.ts — 注入开关（进程内状态, 不落盘）。
 *
 * 缺省关闭；关闭时本插件不往上下文里注入任何内容（阶段模板 / 合规提示 / 最近记录同一门槛）。
 * 状态只活在 `apply` 闭包里：进程重启、插件重载都回到缺省关闭。
 */

/** 开关状态。 */
export interface FlowSwitch {
  enabled: boolean;
}

/** 新建一个缺省关闭的开关。 */
export function createFlowSwitch(): FlowSwitch {
  return { enabled: false };
}

/** 开关状态的一句话文案。 */
export function describeSwitch(state: FlowSwitch): string {
  return state.enabled
    ? "flow-track 注入开关：已打开（进程内有效, 重启回到关闭）"
    : "flow-track 注入开关：已关闭（进程内有效, 重启回到关闭）";
}

/** 当前是否会注入的一句话判定（开关 + 活跃流程）。 */
export function describeGate(state: FlowSwitch, active: boolean): string {
  if (!state.enabled) return "不会注入：开关关闭";
  if (!active) return "不会注入：没有未完成阶段的流程记录";
  return "会注入：开关打开且有未完成阶段的流程记录";
}
