/**
 * `callId → 参数` 表：审批请求只带 `toolName` / `callId` / `reason`（宿主口径，
 * `dsh-user-approval/lib/types/types.d.ts` 明写不复制参数），而沙箱升级类判据需要**命令 / 路径原文**。
 *
 * 数据来源（两路，先写者为准）：
 * 1. `tools/pre-execute` 监听器（首选）——同一次调用的 `exec` 在这里带着完整参数，且
 *    升级请求发生在工具 body 内，**晚于**本监听器（时序天然安全）；
 * 2. `session/event` 的 `tool/call`（补充）——恢复会话 / 参数表被清空后仍能反查出参数
 *    （与 TUI 的 `toolCallsByCallId` 同构），供需要看参数的判据在审批层使用。
 *
 * 取不到就**不猜**：路径 / 命令类判据在该次请求上不生效（落人工面板），见验收 09 / 16。
 */

import type { CallInfo, Decision } from "./types.ts";

/** 带裁定缓存的一条调用记录。 */
interface Entry {
  info: CallInfo;
  /** 已算出的裁定（同一次调用只判一次，见决策 3「单次判定纪律」）。 */
  decision?: Decision;
}

/** 有界的调用表（近似 LRU：Map 插入序）。 */
export class CallTable {
  readonly #capacity: number;
  readonly #entries = new Map<string, Entry>();
  /** 正在判定的 callId（并发去重）。 */
  readonly #pending = new Set<string>();

  constructor(capacity: number) {
    this.#capacity = Math.max(1, Math.floor(capacity));
  }

  /** 记一次调用（同 callId 已存在时不覆盖参数，只补缺字段）。 */
  record(info: CallInfo): CallInfo {
    const existing = this.#entries.get(info.callId);
    if (existing !== undefined) {
      existing.info = {
        ...existing.info,
        ...info,
        arguments:
          info.arguments === undefined ? existing.info.arguments : info.arguments,
      };
      return existing.info;
    }
    this.#entries.set(info.callId, { info });
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    return info;
  }

  /** 取一次调用（未命中返回 undefined = 判据不生效）。 */
  get(callId: string | undefined): CallInfo | undefined {
    if (callId === undefined) return undefined;
    return this.#entries.get(callId)?.info;
  }

  /** 取已缓存的裁定。 */
  decisionOf(callId: string | undefined): Decision | undefined {
    if (callId === undefined) return undefined;
    return this.#entries.get(callId)?.decision;
  }

  /** 缓存裁定（同一次调用的后续审批请求复用）。 */
  cacheDecision(callId: string | undefined, decision: Decision): void {
    if (callId === undefined) return;
    const entry = this.#entries.get(callId);
    if (entry === undefined) return;
    entry.decision = decision;
  }

  /** 标记该 callId 正在判定（返回 false 表示别的路径已在判）。 */
  begin(callId: string): boolean {
    if (this.#pending.has(callId)) return false;
    this.#pending.add(callId);
    return true;
  }

  /** 结束判定标记。 */
  end(callId: string): void {
    this.#pending.delete(callId);
  }

  /** 是否正在判定。 */
  isPending(callId: string): boolean {
    return this.#pending.has(callId);
  }

  /** 清空（测试与降级用）。 */
  clear(): void {
    this.#entries.clear();
    this.#pending.clear();
  }

  /** 条目数。 */
  size(): number {
    return this.#entries.size;
  }
}
