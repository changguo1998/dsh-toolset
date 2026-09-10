// src/state.ts — 上报状态推导（纯函数，便于单测）
//
// 语义对齐 pi 原生扩展 herdr-agent-state.ts 的 desiredState()：
//   - 任一阻塞来源活跃（blocked 集合非空）→ blocked（携带最近一次阻塞 message）；
//   - 否则 agent 活跃（working）→ working；
//   - 否则 → idle。

export type AgentState = "working" | "blocked" | "idle";

/** 一次待上报的状态（state + 可选 message）。 */
export interface DesiredState {
  state: AgentState;
  message?: string;
}

/**
 * 多重阻塞来源计数：begin/end 成对增减，任一来源计数 > 0 即视为阻塞。
 * 支持并发阻塞（如同时等审批与等提问）——每个来源独立计数，全部解除后才释放。
 */
export class BlockTracker {
  private counts = new Map<string, number>();
  private lastMessage: string | undefined;

  /** 进入某阻塞来源（可带该来源的展示文案）。 */
  begin(key: string, message?: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (message !== undefined) {
      this.lastMessage = message;
    }
  }

  /** 离开某阻塞来源；计数归零即移除，集合清空时清空缓存 message。 */
  end(key: string): void {
    const next = (this.counts.get(key) ?? 1) - 1;
    if (next <= 0) {
      this.counts.delete(key);
    } else {
      this.counts.set(key, next);
    }
    if (this.counts.size === 0) {
      this.lastMessage = undefined;
    }
  }

  get blocked(): boolean {
    return this.counts.size > 0;
  }

  get message(): string | undefined {
    return this.blocked ? this.lastMessage : undefined;
  }
}

/** 由 agent 活跃度与阻塞集合推导最终上报状态（pi 原生 desiredState 语义）。 */
export function desiredState(
  agentActive: boolean,
  blocked: boolean,
  blockedMessage?: string,
): DesiredState {
  if (blocked) {
    return { state: "blocked", message: blockedMessage };
  }
  if (agentActive) {
    return { state: "working" };
  }
  return { state: "idle" };
}
