/**
 * pin-note/src/store.ts — memory-base 存储适配（kind `pin`，S 层会话库）。
 *
 * 结构面依赖（不 import memory-base 源码，照 `background-daemon` 的结构化写法）：
 * - 写：`memory.registerKind({kind, writableTiers:["session"], preWrite})` 拿句柄，`scope.put`；
 * - 读：全局 `list` 会跳过 S 层（`memory-base/src/index.ts` 的 `if (isSessionTier(tier)) continue`），
 *   且只遍历**已打开**的库，故必须走层读面：`whenReady().tiers.openExisting("session", sid)`
 *   → `store.kb.listRows({kind})`（只开不建，没写过就返回 undefined）；
 * - 删：`store.kb.evict([{kind, id}])`（不用 `scope.forget` —— 它依赖最近一次会话写入的 id，
 *   且只作用于已打开库）。
 *
 * **结构性依赖**：`whenReady()` 返回的 `bundle.tiers` 属 memory-base 内部结构面（不是公开服务
 * 契约），memory-base 改结构时这里会断。
 */

/** 分类注册声明（memory-base `KindSpec` 的结构子集）。 */
export interface KindSpecLike {
  kind: string;
  writableTiers?: readonly string[];
  preWrite?: (input: {
    content: string;
    title?: string;
    project: string;
    kind: string;
  }) => { accept: boolean; reason?: string };
}

/** 写入入参（memory-base `ScopePutInput` 的结构子集）。 */
export interface ScopePutInputLike {
  content: string;
  tier?: string;
  sessionId?: string;
  title?: string;
  importance?: number;
}

/** 写入结果（`skipped` 非空 = 被内容闸门拒绝，不写库）。 */
export interface PutResultLike {
  ids: number[];
  skipped?: string;
}

/** 写入作用域句柄（memory-base `MemoryScope` 的结构子集）。 */
export interface ScopeLike {
  readonly kind: string;
  put(input: ScopePutInputLike): Promise<PutResultLike>;
}

/** 存储行（`KnowledgeService.listRows` 的返回值子集）。 */
export interface StoreRowLike {
  id: number;
  content: string;
  title: string | null;
  createdAt: number;
}

/** 单层库句柄（`TierStore.kb` 的结构子集）。 */
export interface TierStoreLike {
  kb: {
    listRows(opts: { kind: string; limit?: number }): StoreRowLike[];
    evict(refs: readonly { kind: string; id: number }[]): number;
  };
}

/** bundle 的层读面。 */
export interface BundleLike {
  tiers: {
    openExisting(
      tier: string,
      sessionId?: string,
    ): Promise<TierStoreLike | undefined>;
  };
}

/** 全局面 `ctx.memory` 的结构子集（本包只用注册与层读面）。 */
export interface MemoryFaceLike {
  registerKind(spec: KindSpecLike): ScopeLike;
  whenReady(): Promise<BundleLike>;
}

/** 分类名（memory-base 的 `kind`）。 */
export const PIN_KIND = "pin";

/** 内容下限：过短的碎片不进库（`preWrite` 拒绝）。 */
export const MIN_CONTENT_CHARS = 20;

/** 建议总量（字符）：超了只提示不拒绝。 */
export const SIZE_HINT_THRESHOLD = 10240;

/** 一次读回的最大条数。 */
export const DEFAULT_MAX_NOTES = 50;

/** 一条保持项（对外形态）。 */
export interface PinRecord {
  id: number;
  content: string;
  title: string;
}

/** 登记结果。 */
export type AddResult =
  | { ok: true; id: number; total: number; totalChars: number }
  | {
      ok: false;
      reason:
        | "unavailable"
        | "empty-session"
        | "empty-content"
        | "too-short"
        | "rejected";
      message: string;
    };

/** 体量提示（超建议总量时给模型看的一句话；未超返回 undefined）。 */
export function sizeHint(totalChars: number): string | undefined {
  if (totalChars < SIZE_HINT_THRESHOLD) return undefined;
  return `保持项合计 ${totalChars} 字, 已超过建议总量 ${SIZE_HINT_THRESHOLD} 字；建议只保留大致思路与风格要求, 删掉大段原文。`;
}

/**
 * memory-base 上的 pin 存储：注册一次 kind、复用同一个句柄。
 * `registerKind` 抛错（同名重复注册 / 表名冲突）或服务面缺方法时构造出的实例 `available` 为 false，
 * 调用方据此跳过工具注册与注入。
 */
export class PinStore {
  readonly #memory: MemoryFaceLike;
  readonly #maxNotes: number;
  readonly #scope: ScopeLike | undefined;
  readonly #error: string | undefined;

  constructor(memory: MemoryFaceLike, options?: { maxNotes?: number }) {
    this.#memory = memory;
    this.#maxNotes = options?.maxNotes ?? DEFAULT_MAX_NOTES;
    let scope: ScopeLike | undefined;
    let error: string | undefined;
    try {
      scope = memory.registerKind({
        kind: PIN_KIND,
        writableTiers: ["session"],
        preWrite: (input) =>
          input.content.trim().length < MIN_CONTENT_CHARS
            ? {
                accept: false,
                reason: `内容过短（少于 ${MIN_CONTENT_CHARS} 字）, 不登记`,
              }
            : { accept: true },
      });
    } catch (cause) {
      error = String(cause);
    }
    this.#scope = scope;
    this.#error = error;
  }

  /** 写入句柄是否可用。 */
  get available(): boolean {
    return this.#scope !== undefined;
  }

  /** 注册失败原因（可用时为 undefined）。 */
  get unavailableReason(): string | undefined {
    return this.#error;
  }

  /** 本会话的保持项（按登记时间正序）。 */
  async list(sessionId: string): Promise<PinRecord[]> {
    const store = await this.#open(sessionId);
    if (store === undefined) return [];
    return store.kb
      .listRows({ kind: PIN_KIND, limit: this.#maxNotes })
      .map((row) => ({
        id: row.id,
        content: row.content,
        title: row.title ?? "",
      }))
      .reverse();
  }

  /** 登记一条；返回新 id 与登记后条数。 */
  async add(
    sessionId: string,
    content: string,
    title?: string,
  ): Promise<AddResult> {
    const scope = this.#scope;
    if (scope === undefined) {
      return {
        ok: false,
        reason: "unavailable",
        message: `memory-base 分类 ${PIN_KIND} 未注册成功：${this.#error ?? "原因未知"}`,
      };
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        reason: "empty-content",
        message: "content 不能为空",
      };
    }
    if (trimmed.length < MIN_CONTENT_CHARS) {
      return {
        ok: false,
        reason: "too-short",
        message: `内容过短（少于 ${MIN_CONTENT_CHARS} 字）, 请写清要点后再登记`,
      };
    }
    let result: PutResultLike;
    try {
      result = await scope.put({
        content: trimmed,
        tier: "session",
        sessionId,
        importance: 4,
        ...(title === undefined || title.trim().length === 0
          ? {}
          : { title: title.trim() }),
      });
    } catch (cause) {
      return {
        ok: false,
        reason: "rejected",
        message: `写入会话层失败：${String(cause)}`,
      };
    }
    const id = result.ids[0];
    if (id === undefined) {
      return {
        ok: false,
        reason: "rejected",
        message: `内容被 memory-base 闸门拒绝（${result.skipped ?? "原因未知"}）`,
      };
    }
    const records = await this.list(sessionId);
    const totalChars = records.reduce(
      (sum, record) => sum + record.content.length,
      0,
    );
    return { ok: true, id, total: records.length, totalChars };
  }

  /** 删一条；返回是否真的删掉。 */
  async remove(sessionId: string, id: number): Promise<boolean> {
    const store = await this.#open(sessionId);
    if (store === undefined) return false;
    return store.kb.evict([{ kind: PIN_KIND, id }]) > 0;
  }

  /** 打开本会话的层库（只开不建）。 */
  async #open(sessionId: string): Promise<TierStoreLike | undefined> {
    if (sessionId.length === 0) return undefined;
    try {
      const bundle = await this.#memory.whenReady();
      return await bundle.tiers.openExisting("session", sessionId);
    } catch {
      return undefined;
    }
  }
}
