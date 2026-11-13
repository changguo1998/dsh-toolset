/**
 * flow-track/src/store.ts — 流程状态与正文的存储（memory-base kind `flow`，P 层项目库）。
 *
 * 口径（决策项 3 = b 的目标形态）：一条记录 = 某任务某阶段的一次推进（`title` = `<slug>@<阶段>`，
 * `content` = 正文 + 状态行）。本包只保证「写进去读得出来」，不改 `docs/WORKFLOW-STANDARD.md` 的
 * 追踪文档规则（决策项边界）。
 *
 * P 层与 S 层不同：全局面 `list` 会按需 `openExisting` 打开项目库（`memory-base/src/index.ts`），
 * 可以直接读回，不需要走 `bundle.tiers`。
 */

/** 删除引用（memory-base `MemoryScope.forget` 的结构子集）。 */
export interface ForgetRefLike {
  tier: string;
  ids: readonly number[];
}

/** 写入作用域句柄（memory-base `MemoryScope` 的结构子集）。 */
export interface ScopeLike {
  put(input: {
    content: string;
    tier?: string;
    title?: string;
    importance?: number;
    sessionId?: string;
  }): Promise<{ ids: number[]; skipped?: string }>;
  forget?(refs: readonly ForgetRefLike[]): Promise<number>;
}

/** 分类注册声明（`KindSpec` 的结构子集）。 */
export interface KindSpecLike {
  kind: string;
  writableTiers?: readonly string[];
}

/** 存储行（`StoreRow` 的结构子集）。 */
export interface StoreRowLike {
  id: number;
  title: string | null;
  content: string;
  createdAt: number;
  sessionId: string | null;
}

/** 全局面 `ctx.memory` 的结构子集（本包只用注册与列举）。 */
export interface MemoryFaceLike {
  registerKind(spec: KindSpecLike): ScopeLike;
  list?(opts: {
    kind?: string;
    tier?: string;
    limit?: number;
  }): Promise<StoreRowLike[]>;
}

/** 取 memory 服务的函数（每次调用重读，服务晚到也能用）。 */
export type MemoryProvider = () => MemoryFaceLike | undefined;

/** 分类名。 */
export const FLOW_KIND = "flow";

/** 流程记录的阶段取值（与 `stages.ts` 的阶段名一致，另允许 `-` 表示整体）。 */
export type FlowStage = string;

/** 推进状态。 */
export type FlowStatus = "start" | "done" | "blocked" | "note";

/** 写入入参。 */
export interface FlowRecordInput {
  slug: string;
  stage: FlowStage;
  status: FlowStatus;
  body?: string;
  sessionId?: string;
}

/** 读出的记录。 */
export interface FlowRecord {
  id: number;
  slug: string;
  stage: string;
  status: FlowStatus | "unknown";
  body: string;
  createdAt: number;
}

/** 写入结果。 */
export type RecordResult =
  | { ok: true; id: number }
  | {
      ok: false;
      reason: "unavailable" | "invalid" | "rejected";
      message: string;
    };

/** 删除结果。 */
export type RemovalResult =
  | { ok: true; removed: number; ids: number[] }
  | {
      ok: false;
      reason: "unavailable" | "invalid" | "rejected";
      message: string;
    };

/** 一次读回的最大条数。 */
export const DEFAULT_LIST_LIMIT = 50;

/** 按 slug 删除时最多扫描的历史条数。 */
export const REMOVE_SCAN_LIMIT = 200;

/** 标题分隔符（`<slug>@<阶段>`）。 */
const TITLE_SEPARATOR = "@";

/** 解析标题：不是本包写的行返回 undefined。 */
function parseTitle(
  title: string | null,
): { slug: string; stage: string } | undefined {
  if (title === null) return undefined;
  const at = title.lastIndexOf(TITLE_SEPARATOR);
  if (at <= 0) return undefined;
  return {
    slug: title.slice(0, at),
    stage: title.slice(at + 1),
  };
}

/** 解析正文首行状态（`状态: done`）。 */
function parseStatus(content: string): FlowStatus | "unknown" {
  const first = content.split("\n")[0] ?? "";
  const found = first.match(/^状态: (start|done|blocked|note)$/);
  return (found?.[1] as FlowStatus | undefined) ?? "unknown";
}

/** 正文去掉状态行后的部分。 */
function parseBody(content: string): string {
  const index = content.indexOf("\n");
  return index < 0 ? "" : content.slice(index + 1);
}

/** 跨 HMR 重载的句柄缓存键（挂在 globalThis 上：模块重载后缓存仍在）。 */
const SCOPE_REGISTRY_KEY = Symbol.for("dsh-toolset.flow-track.scopes");

/**
 * 取（或首次注册）本 memory 服务上的 `flow` 写入句柄。
 *
 * 为什么要缓存：HMR 重载插件时 `apply` 会再跑一次，而 memory-base 的分类注册是**进程级**的
 * （同名二次注册直接抛错）。把句柄按 memory 服务对象缓存在 `globalThis` 上，重载后复用同一个
 * 句柄，写入能力不会因重载丢失。
 */
function scopeFor(memory: MemoryFaceLike): ScopeLike {
  const holder = globalThis as unknown as Record<
    symbol,
    WeakMap<object, ScopeLike> | undefined
  >;
  const registry =
    holder[SCOPE_REGISTRY_KEY] ??
    (holder[SCOPE_REGISTRY_KEY] = new WeakMap<object, ScopeLike>());
  const cached = registry.get(memory as object);
  if (cached !== undefined) return cached;
  const scope = memory.registerKind({
    kind: FLOW_KIND,
    writableTiers: ["project"],
  });
  registry.set(memory as object, scope);
  return scope;
}

/**
 * 流程记录存储：首次用到时懒注册 kind、复用同一个句柄（跳 HMR 重载复用）。
 *
 * memory 服务可用传实例或「取服务的函数」：传函数时每次调用重新读取，服务晚到也能用；
 * 解析成功才缓存句柄，失败不缓存（装配顺序不保证 memory-base 先就绪）。
 * `registerKind` 抛错或服务面缺方法时 `available` 为 false，调用方据此给可读错误。
 */
export class FlowStore {
  readonly #memoryOf: MemoryProvider;
  #memory: MemoryFaceLike | undefined;
  #scope: ScopeLike | undefined;
  #error: string | undefined;

  constructor(memory: MemoryFaceLike | MemoryProvider) {
    this.#memoryOf = typeof memory === "function" ? memory : () => memory;
    this.#memory = undefined;
    this.#scope = undefined;
    this.#error = undefined;
  }

  /** 读 memory 服务（读不到就给可读原因；下一次调用重试）。 */
  #memoryFace(): MemoryFaceLike | undefined {
    if (this.#memory !== undefined) return this.#memory;
    let memory: MemoryFaceLike | undefined;
    try {
      memory = this.#memoryOf();
    } catch (cause) {
      this.#error = String(cause);
      return undefined;
    }
    if (memory === undefined) {
      this.#error = "ctx.memory 不可用（请检查 memory-base 是否挂载）";
      return undefined;
    }
    this.#memory = memory;
    this.#error = undefined;
    return memory;
  }

  /** 取写入句柄（首次用到才注册；注册失败不缓存，下次重试）。 */
  #writeScope(): ScopeLike | undefined {
    if (this.#scope !== undefined) return this.#scope;
    const memory = this.#memoryFace();
    if (memory === undefined) return undefined;
    try {
      this.#scope = scopeFor(memory);
      this.#error = undefined;
    } catch (cause) {
      this.#error = String(cause);
    }
    return this.#scope;
  }

  /** 写句柄是否可用（会触发一次懒解析）。 */
  get available(): boolean {
    return this.#writeScope() !== undefined;
  }

  /** 注册失败原因（会触发一次懒解析）。 */
  get unavailableReason(): string | undefined {
    this.#writeScope();
    return this.#error;
  }

  /** 写一条推进记录。 */
  async record(input: FlowRecordInput): Promise<RecordResult> {
    const scope = this.#writeScope();
    if (scope === undefined) {
      return {
        ok: false,
        reason: "unavailable",
        message: `memory-base 分类 ${FLOW_KIND} 未注册成功：${this.#error ?? "原因未知"}`,
      };
    }
    const slug = input.slug.trim();
    const stage = input.stage.trim();
    if (slug.length === 0 || stage.length === 0) {
      return {
        ok: false,
        reason: "invalid",
        message: "slug 与 stage 都不能为空",
      };
    }
    const body = (input.body ?? "").trim();
    const content =
      body.length === 0
        ? `状态: ${input.status}`
        : `状态: ${input.status}\n${body}`;
    try {
      const result = await scope.put({
        content,
        tier: "project",
        title: `${slug}${TITLE_SEPARATOR}${stage}`,
        importance: 3,
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
      });
      const id = result.ids[0];
      if (id === undefined) {
        return {
          ok: false,
          reason: "rejected",
          message: `内容被 memory-base 闸门拒绝（${result.skipped ?? "原因未知"}）`,
        };
      }
      return { ok: true, id };
    } catch (cause) {
      return {
        ok: false,
        reason: "rejected",
        message: `写入项目层失败：${String(cause)}`,
      };
    }
  }

  /** 按 id 批量删（顺序策略与回退共用；空列表视为成功）。 */
  async removeMany(ids: readonly number[]): Promise<RemovalResult> {
    const scope = this.#writeScope();
    if (scope === undefined) {
      return {
        ok: false,
        reason: "unavailable",
        message: `memory-base 分类 ${FLOW_KIND} 未注册成功：${this.#error ?? "原因未知"}`,
      };
    }
    const forget = scope.forget;
    if (typeof forget !== "function") {
      return {
        ok: false,
        reason: "unavailable",
        message: "memory-base 句柄不支持 forget，流程记录无法删除",
      };
    }
    if (ids.length === 0) return { ok: true, removed: 0, ids: [] };
    try {
      const removed = await forget.call(scope, [{ tier: "project", ids }]);
      return { ok: true, removed, ids: [...ids] };
    } catch (cause) {
      return {
        ok: false,
        reason: "rejected",
        message: `删除项目层记录失败：${String(cause)}`,
      };
    }
  }

  /** 删记录：`id` 一条, `slug` 一整个任务（二选一）。 */
  async remove(options: {
    id?: number;
    slug?: string;
  }): Promise<RemovalResult> {
    let ids: number[];
    if (options.id !== undefined) {
      ids = [options.id];
    } else {
      const slug = (options.slug ?? "").trim();
      if (slug.length === 0) {
        return { ok: false, reason: "invalid", message: "需要 id 或 slug" };
      }
      const memory = this.#memoryFace();
      if (
        this.#writeScope() === undefined ||
        typeof memory?.list !== "function"
      ) {
        return {
          ok: false,
          reason: "unavailable",
          message:
            this.#scope === undefined
              ? `memory-base 分类 ${FLOW_KIND} 未注册成功：${this.#error ?? "原因未知"}`
              : "memory-base 读数面不可用，无法按 slug 定位记录",
        };
      }
      const records = await this.list({ slug, limit: REMOVE_SCAN_LIMIT });
      ids = records.map((record) => record.id);
    }
    return this.removeMany(ids);
  }

  /** 列记录（按 `slug` 前缀过滤；时间正序）。 */
  async list(options?: {
    slug?: string;
    limit?: number;
  }): Promise<FlowRecord[]> {
    const memory = this.#memoryFace();
    const list = memory?.list;
    if (memory === undefined || typeof list !== "function") return [];
    let rows: StoreRowLike[];
    try {
      rows = await list.call(memory, {
        kind: FLOW_KIND,
        tier: "project",
        limit: options?.limit ?? DEFAULT_LIST_LIMIT,
      });
    } catch {
      return [];
    }
    const slug = options?.slug;
    const out: FlowRecord[] = [];
    for (const row of rows) {
      const parsed = parseTitle(row.title);
      if (parsed === undefined) continue;
      if (slug !== undefined && parsed.slug !== slug) continue;
      out.push({
        id: row.id,
        slug: parsed.slug,
        stage: parsed.stage,
        status: parseStatus(row.content),
        body: parseBody(row.content),
        createdAt: row.createdAt,
      });
    }
    // 全局面 list 按 created_at 倒序；这里翻成时间正序, 便于按序阅读推进过程
    return out.reverse();
  }
}
