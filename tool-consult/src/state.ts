/**
 * state.ts — 每代理的授权状态机（纯数据 + 纯函数式方法，无宿主依赖）。
 *
 * 两档语义（见 DESIGN D3）：
 * - `session`：一次揭示在整个会话内可见，`turn/end` 不收回；`maxRevealed` 是
 *   新增揭示的硬上限，超限拒绝新增（不抽走已授权）。
 * - `turn`：揭示项在本回合有效，`turn/end` 按 LRU 收敛到 `maxRevealed` 容量，
 *   并支持 `ttlTurns` 闲置收回；`pin` 的项不参与收敛，受 `maxPinned` 限制。
 *
 * 切换：`session` → `turn` 时先把既有 session 项标记为待降级，下一次
 * `converge()` 统一降级后再收敛；`turn` → `session` 时立即提升为 session 项。
 */

import type { RevealScope } from "./config.ts";

/** 一条授权记录。 */
export interface GrantEntry {
  scope: RevealScope;
  /** 仅 turn 档有意义：钉住后不参与 LRU / TTL 收回。 */
  pinned: boolean;
  /** 首次揭示所在回合。 */
  revealedTurn: number;
  /** 最近一次使用所在回合（未被调用时等于 revealedTurn）。 */
  lastUsedTurn: number;
}

/** 一次揭示的结果。 */
export interface GrantResult {
  /** 是否新增了授权（false 表示已存在或被上限拒绝）。 */
  granted: boolean;
  /** 状态：新增 / 已存在 / session 超上限拒绝。 */
  status: "granted" | "already" | "rejected-cap";
  /** 请求了 pin 且确实生效。 */
  pinApplied: boolean;
  /** 请求了 pin 但未生效（session 档无意义，或 turn 档钉住名额已满）。 */
  pinIgnored: "session-scope" | "pinned-full" | undefined;
}

/** 收敛 / 切换的可调上限。 */
export interface GrantLimits {
  maxRevealed: number;
  ttlTurns: number;
  maxPinned: number;
}

/** 收敛结果。 */
export interface ConvergeResult {
  /** 被收回的工具名（排序）。 */
  removed: string[];
  /** 从 session 降级为 turn 的工具名（排序）。 */
  demoted: string[];
  /** 是否发生了可见集变化（调用方据此决定是否重挂遮罩）。 */
  changed: boolean;
}

/**
 * 单个代理的授权集合。所有方法同步、无副作用外溢；调用方负责把
 * `allowedNames()` 的差量落到宿主遮罩上。
 */
export class AgentGrants {
  private readonly entries = new Map<string, GrantEntry>();
  private scope: RevealScope;
  /** session 档期间积累的项，在切到 turn 后的下一个 turn/end 降级。 */
  private demoteOnNextConverge = false;

  constructor(scope: RevealScope) {
    this.scope = scope;
  }

  /** 当前缺省档。 */
  mode(): RevealScope {
    return this.scope;
  }

  /** 是否已授权（含 session 与 turn 项）。 */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** 全部已授权的工具名（排序）。 */
  allowedNames(): string[] {
    return [...this.entries.keys()].sort((a, b) => a.localeCompare(b));
  }

  /** session 项数量（`maxRevealed` 在 session 档的口径）。 */
  sessionCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.scope === "session") count += 1;
    return count;
  }

  /** turn 项数量（`maxRevealed` 在 turn 档的口径，含钉住项）。 */
  turnCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.scope === "turn") count += 1;
    return count;
  }

  /** 钉住的 turn 项数量。 */
  pinnedCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.pinned) count += 1;
    return count;
  }

  /** 取一条记录（测试与渲染用）。 */
  get(name: string): GrantEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * 揭示（授权）一个工具。
   * @param name 工具名。
   * @param scope 本次揭示的作用域（已按优先级解析）。
   * @param pin 是否钉住（仅 turn 档有意义）。
   * @param turn 当前回合号。
   * @param limits 上限配置。
   */
  grant(
    name: string,
    scope: RevealScope,
    pin: boolean,
    turn: number,
    limits: GrantLimits,
  ): GrantResult {
    if (this.entries.has(name)) {
      return { granted: false, status: "already", pinApplied: false, pinIgnored: undefined };
    }
    if (scope === "session" && this.sessionCount() >= limits.maxRevealed) {
      return { granted: false, status: "rejected-cap", pinApplied: false, pinIgnored: undefined };
    }
    let applied = false;
    let ignored: GrantResult["pinIgnored"];
    if (pin) {
      if (scope === "session") ignored = "session-scope";
      else if (this.pinnedCount() >= limits.maxPinned) ignored = "pinned-full";
      else applied = true;
    }
    this.entries.set(name, {
      scope,
      pinned: applied,
      revealedTurn: turn,
      lastUsedTurn: turn,
    });
    return { granted: true, status: "granted", pinApplied: applied, pinIgnored: ignored };
  }

  /** 记录一次使用（刷新 LRU 时间戳）。 */
  noteUse(name: string, turn: number): void {
    const entry = this.entries.get(name);
    if (entry !== undefined) entry.lastUsedTurn = Math.max(entry.lastUsedTurn, turn);
  }

  /** 工具被注销时静默移除。 */
  forget(name: string): boolean {
    return this.entries.delete(name);
  }

  /**
   * 切换缺省档：turn → session 立即提升；session → turn 标记待降级。
   * @param next 新的缺省档。
   * @returns 是否改变了既有序（提升 / 待降级）。
   */
  switchScope(next: RevealScope): { promoted: number; pendingDemotion: number } {
    if (next === this.scope) return { promoted: 0, pendingDemotion: 0 };
    this.scope = next;
    if (next === "session") {
      let promoted = 0;
      for (const entry of this.entries.values()) {
        if (entry.scope === "turn") {
          entry.scope = "session";
          entry.pinned = false;
          promoted += 1;
        }
      }
      this.demoteOnNextConverge = false;
      return { promoted, pendingDemotion: 0 };
    }
    let pending = 0;
    for (const entry of this.entries.values()) if (entry.scope === "session") pending += 1;
    this.demoteOnNextConverge = pending > 0;
    return { promoted: 0, pendingDemotion: pending };
  }

  /**
   * 回合末收敛（只处理 turn 项）：先做待降级，再 TTL，再 LRU 容量。
   * 本回合揭示或调用过的项不参与本轮收回（宽限），下一回合再收敛。
   * @param turn 刚结束的回合号。
   * @param limits 上限配置。
   */
  converge(turn: number, limits: GrantLimits): ConvergeResult {
    const removed: string[] = [];
    const demoted: string[] = [];

    if (this.demoteOnNextConverge) {
      for (const [name, entry] of [...this.entries.entries()]) {
        if (entry.scope === "session") {
          entry.scope = "turn";
          entry.pinned = false;
          demoted.push(name);
        }
      }
      this.demoteOnNextConverge = false;
    }

    // TTL：闲置够久的 turn 项收回（本回合碰过的不算闲置）。
    if (limits.ttlTurns > 0) {
      for (const [name, entry] of [...this.entries.entries()]) {
        if (entry.scope !== "turn" || entry.pinned) continue;
        if (isFresh(entry, turn)) continue;
        if (turn - entry.lastUsedTurn >= limits.ttlTurns) {
          this.entries.delete(name);
          removed.push(name);
        }
      }
    }

    // 容量：turn 项超过 maxRevealed 时按 LRU 收回（钉住项免收；宽限项本轮跳过）。
    const turnItems = [...this.entries.entries()].filter(([, entry]) => entry.scope === "turn");
    if (turnItems.length > limits.maxRevealed) {
      const candidates = turnItems
        .filter(([, entry]) => !entry.pinned && !isFresh(entry, turn))
        .sort((a, b) => (a[1].lastUsedTurn - b[1].lastUsedTurn)
          || (a[1].revealedTurn - b[1].revealedTurn)
          || a[0].localeCompare(b[0]));
      let overflow = turnItems.length - limits.maxRevealed;
      for (const [name] of candidates) {
        if (overflow <= 0) break;
        this.entries.delete(name);
        removed.push(name);
        overflow -= 1;
      }
    }

    removed.sort((a, b) => a.localeCompare(b));
    demoted.sort((a, b) => a.localeCompare(b));
    return { removed, demoted, changed: removed.length > 0 || demoted.length > 0 };
  }
}

/** 本回合揭示或调用过的项（宽限）。 */
function isFresh(entry: GrantEntry, turn: number): boolean {
  return entry.revealedTurn === turn || entry.lastUsedTurn === turn;
}
