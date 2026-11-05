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

/** 写入作用域句柄（memory-base `MemoryScope` 的结构子集）。 */
export interface ScopeLike {
  put(input: {
    content: string;
    tier?: string;
    title?: string;
    importance?: number;
    sessionId?: string;
  }): Promise<{ ids: number[]; skipped?: string }>;
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

/** 一次读回的最大条数。 */
export const DEFAULT_LIST_LIMIT = 50;

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

/**
 * 流程记录存储：注册一次 kind、复用同一个句柄。
 * `registerKind` 抛错或服务面缺方法时 `available` 为 false，调用方据此给可读错误。
 */
export class FlowStore {
  readonly #memory: MemoryFaceLike;
  readonly #scope: ScopeLike | undefined;
  readonly #error: string | undefined;

  constructor(memory: MemoryFaceLike) {
    this.#memory = memory;
    let scope: ScopeLike | undefined;
    let error: string | undefined;
    try {
      scope = memory.registerKind({
        kind: FLOW_KIND,
        writableTiers: ["project"],
      });
    } catch (cause) {
      error = String(cause);
    }
    this.#scope = scope;
    this.#error = error;
  }

  /** 写句柄是否可用。 */
  get available(): boolean {
    return this.#scope !== undefined;
  }

  /** 注册失败原因。 */
  get unavailableReason(): string | undefined {
    return this.#error;
  }

  /** 写一条推进记录。 */
  async record(input: FlowRecordInput): Promise<RecordResult> {
    const scope = this.#scope;
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

  /** 列记录（按 `slug` 前缀过滤；时间正序）。 */
  async list(options?: {
    slug?: string;
    limit?: number;
  }): Promise<FlowRecord[]> {
    const list = this.#memory.list;
    if (typeof list !== "function") return [];
    let rows: StoreRowLike[];
    try {
      rows = await list.call(this.#memory, {
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
