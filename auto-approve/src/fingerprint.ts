/**
 * 同会话指纹表：把一次调用折算成**稳定的等价指纹**，记住「已批准过」的那些。
 *
 * 设计口径（决策 1 表格第 2 行）：
 * - 只在**同一个会话内**有效（与宿主「一次性授权」语义一致，不外扩到其它会话）；
 * - 只有 `allowed-once` 的调用进放行集；被拒绝过的等价调用**不进**（下次重新判定）；
 * - 达到容量上限按近似 LRU 淘汰（Map 插入序即首次批准序，重复命中不重排 —— 近似，够用）。
 *
 * 指纹内容 = `toolName` + **规范化后的参数**（对象键排序）+ 升级目标模式（若这次是升级请求）。
 * 不含理由文本 / justification（那些可被话术诱导，见决策 1 补充 ②）。
 */

import { createHash } from "node:crypto";
import type { FingerprintView } from "./types.ts";

/** 参数规范化：对象键排序后序列化（数组保持原序；不可序列化值按 `String`）。 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortValue(record[key]);
    }
    return out;
  }
  if (typeof value === "function" || typeof value === "symbol") return null;
  return value;
}

/** 等价指纹（sha256 前 16 位十六进制）。 */
export function fingerprintOf(
  toolName: string,
  args: unknown,
  escalationTarget?: string,
): string {
  const payload = {
    tool: toolName,
    args: canonicalize(args),
    ...(escalationTarget === undefined ? {} : { to: escalationTarget }),
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}

interface Entry {
  toolName: string;
  approvedAt: string;
}

/** 单会话有界指纹表（近似 LRU）。 */
export class FingerprintStore {
  readonly #capacity: number;
  readonly #sessions = new Map<string, Map<string, Entry>>();

  constructor(capacity: number) {
    this.#capacity = Math.max(1, Math.floor(capacity));
  }

  /** 是否已批准过该指纹。 */
  has(sessionId: string, hash: string): boolean {
    const table = this.#sessions.get(sessionId);
    if (table === undefined) return false;
    const entry = table.get(hash);
    if (entry === undefined) return false;
    return true;
  }

  /** 记一次批准（幂等；超容量淘汰最早的条目）。 */
  approve(
    sessionId: string,
    hash: string,
    toolName: string,
    now = new Date(),
  ): void {
    let table = this.#sessions.get(sessionId);
    if (table === undefined) {
      table = new Map<string, Entry>();
      this.#sessions.set(sessionId, table);
    }
    if (table.has(hash)) return;
    table.set(hash, { toolName, approvedAt: now.toISOString() });
    while (table.size > this.#capacity) {
      const oldest = table.keys().next();
      if (oldest.done === true) break;
      table.delete(oldest.value);
    }
  }

  /** 清空一个会话（`/autoapprove clear-fingerprints`）。 */
  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.#sessions.clear();
      return;
    }
    this.#sessions.delete(sessionId);
  }

  /** 某会话的条目数（未给会话时取全部）。 */
  size(sessionId?: string): number {
    if (sessionId !== undefined)
      return this.#sessions.get(sessionId)?.size ?? 0;
    let total = 0;
    for (const table of this.#sessions.values()) total += table.size;
    return total;
  }

  /** 视图（新→旧不保证；按会话 id 升序、会话内按批准时间升序）。 */
  list(sessionId?: string): FingerprintView[] {
    const out: FingerprintView[] = [];
    const ids =
      sessionId === undefined ? [...this.#sessions.keys()].sort() : [sessionId];
    for (const id of ids) {
      const table = this.#sessions.get(id);
      if (table === undefined) continue;
      const entries = [...table.entries()].sort((a, b) =>
        a[1].approvedAt.localeCompare(b[1].approvedAt),
      );
      for (const [hash, entry] of entries) {
        out.push({
          sessionId: id,
          fingerprintHash: hash,
          toolName: entry.toolName,
          approvedAt: entry.approvedAt,
        });
      }
    }
    return out;
  }
}
