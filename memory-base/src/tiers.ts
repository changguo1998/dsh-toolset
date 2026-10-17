/**
 * 分层库集合（设计 §2 / §7 / §8；2026-10-17 接口重设后口径）：
 * S 会话 / P 项目 / U 用户三个库的**惰性**打开、写入路由与跨全域检索。
 *
 * 不变量：
 * - **层级恒开启**：没有开关、没有单库形态；启动只解析路径，**首次写到某层才建 / 打开该库**；
 * - **一库一指纹**（`schema.ts`）：层拿错即拒绝打开，旧库不会被自动读取；
 * - **S 层落点按会话解析**：`sessionPaths.sessionDirFor(sessionId)` 给目录（决策项 11 选 d），
 *   本包不碰路径推导、也不认识宿主会话服务的内部形态；
 * - **写入按层直落**：`tier` 直写目标层，目标层不可用即抛明示例外（不退化、不静默换路径）；
 * - **检索跨层只读**：按 U > P > S 的层权重 + 分数排序（设计 §7）。
 */

import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { openTierDatabase, type JournalMode } from "./schema.ts";
import {
  KnowledgeService,
  type ListOptions,
  type PutInput,
  type PutResult,
  type RowRef,
  type SearchHit,
  type SearchOptions,
  type StoreRow,
} from "./knowledge.ts";
import { TIERS, type KindRegistry, type Tier } from "./router.ts";
import type { CompiledRules } from "./rules.ts";

/** 库文件名（随层固定）。 */
export const TIER_DB_FILES: Record<Tier, string> = {
  session: "session.db",
  project: "project.db",
  user: "user.db",
};

/**
 * 会话目录解析面（由 `session-paths` 插件提供；缺失时 S 层写入报明示例外）。
 * 只依赖这一个方法，故以结构化类型声明，不 import 该包（避免未落地时的构建依赖）。
 */
export interface SessionPathsLike {
  sessionDirFor(sessionId: string): string;
}

/** 一个已打开的层库。 */
export interface TierStore {
  tier: Tier;
  /** 会话层为该会话的库路径；P / U 层固定。 */
  path: string;
  db: DatabaseSync;
  kb: KnowledgeService;
  /** 该库所在项目的键（P 层有意义；S / U 为空串）。 */
  project: string;
}

/** 只读用量快照（只报**已创建**的库；容量上限已随逐库守卫取消）。 */
export interface TierUsage {
  tier: Tier;
  path: string;
  bytes: number;
}

/** 跨层检索命中：单库命中 + 层身份（`SearchHit` 已带 `tier`，此别名保留调用方语义）。 */
export type LayeredHit = SearchHit;

/** 打开三库的入参。 */
export interface OpenTierSetOptions {
  /** U 库落点 `<dshHome>/memory-base/user.db`。 */
  dshHome: string;
  /** P 库落点 `<projectRoot>/.dsh/project.db`；不传则没有项目层。 */
  projectRoot?: string;
  /** 会话目录解析面（`session-paths` 服务）；缺失时写 S 层抛错。 */
  sessionPaths?: SessionPathsLike;
  journalMode?: JournalMode;
  /** 各层共用的内容闸门（设计 §5：闸门在库核心）；缺省只用内置隐私底线。 */
  rules?: CompiledRules;
  /** 各层共用的分类注册表（设计 §4）：缺省空表。 */
  registry?: KindRegistry;
}

/** 三库集合：惰性打开、路由、跨层检索。 */
export class TierSet {
  readonly #journalMode: JournalMode;
  readonly #projectRoot: string | undefined;
  readonly #userPath: string;
  readonly #sessionPaths: SessionPathsLike | undefined;
  readonly #rules: CompiledRules | undefined;
  readonly #registry: KindRegistry | undefined;
  /** 已打开的库：S 层按 `sessionId` 键，P / U 层用空串键。 */
  readonly #stores = new Map<string, TierStore>();
  /** 每个层库首次打开时记录落点（「打开日志与落点一致」的证据面）。 */
  readonly #opened: Array<{ tier: Tier; path: string }> = [];

  private constructor(opts: OpenTierSetOptions) {
    this.#journalMode = opts.journalMode ?? "wal";
    this.#projectRoot = opts.projectRoot;
    this.#userPath = join(opts.dshHome, "memory-base", TIER_DB_FILES.user);
    this.#sessionPaths = opts.sessionPaths;
    this.#rules = opts.rules;
    this.#registry = opts.registry;
  }

  /** 只解析落点，不打开任何库（库在首次写入时惰性创建）。 */
  static open(opts: OpenTierSetOptions): TierSet {
    return new TierSet(opts);
  }

  /** 层的库路径；S 层缺 `sessionId`、P 层无项目根、或会话目录解析失败时为 `undefined`。 */
  pathFor(tier: Tier, sessionId?: string): string | undefined {
    if (tier === "user") return this.#userPath;
    if (tier === "project") {
      return this.#projectRoot === undefined
        ? undefined
        : join(this.#projectRoot, ".dsh", TIER_DB_FILES.project);
    }
    if (this.#sessionPaths === undefined || (sessionId ?? "").length === 0) {
      return undefined;
    }
    return join(
      this.#sessionPaths.sessionDirFor(sessionId as string),
      TIER_DB_FILES.session,
    );
  }

  /** 已打开的层库（S 层需给 `sessionId`）。 */
  opened(tier: Tier, sessionId?: string): TierStore | undefined {
    return this.#stores.get(storeKey(tier, sessionId));
  }

  /** 全部已打开的库。 */
  all(): readonly TierStore[] {
    return [...this.#stores.values()];
  }

  /**
   * 取**可写**的层库：已打开则复用；否则按落点惰性打开（首次打开即建库）。
   * 落点解析失败 / 库打开失败一律抛错（调用方据此拒绝写入，不静默换路径）。
   */
  async openWritable(tier: Tier, sessionId?: string): Promise<TierStore> {
    const key = storeKey(tier, sessionId);
    const existing = this.#stores.get(key);
    if (existing !== undefined) return existing;
    if (tier === "session" && this.#sessionPaths === undefined) {
      throw new Error(
        "memory-base 写会话层需要 session-paths 服务（未挂载时无法解析会话目录）",
      );
    }
    if (tier === "session" && (sessionId ?? "").length === 0) {
      throw new Error(
        "memory-base 写会话层需要 sessionId（会话层落点按会话解析）",
      );
    }
    if (tier === "project" && this.#projectRoot === undefined) {
      throw new Error("memory-base 写项目层需要 projectRoot（未配置项目根）");
    }
    const path = this.pathFor(tier, sessionId);
    if (path === undefined) {
      throw new Error(`memory-base 无法解析 ${tier} 层落点`);
    }
    const db = await openTierDatabase(path, tier, this.#journalMode);
    return this.#register(
      tier,
      sessionId,
      path,
      db,
      tier === "project" ? (this.#projectRoot ?? "") : "",
    );
  }

  /**
   * 取**已存在**的层库（只读 / 删除用；落点文件不存在时返回 `undefined`）。
   * 与 `openWritable` 的区别：这里绝不创建库——读与删除不该在磁盘上留新文件。
   */
  async openExisting(
    tier: Tier,
    sessionId?: string,
  ): Promise<TierStore | undefined> {
    const key = storeKey(tier, sessionId);
    const existing = this.#stores.get(key);
    if (existing !== undefined) return existing;
    // S 层缺 `sessionPaths` 时无法解析落点，直接视为不存在。
    if (tier === "session" && this.#sessionPaths === undefined)
      return undefined;
    if (tier === "session" && (sessionId ?? "").length === 0) return undefined;
    const path = this.pathFor(tier, sessionId);
    if (path === undefined || !existsSync(path)) return undefined;
    const db = await openTierDatabase(path, tier, this.#journalMode);
    return this.#register(
      tier,
      sessionId,
      path,
      db,
      tier === "project" ? (this.#projectRoot ?? "") : "",
    );
  }

  /** 已创建（落点文件存在）的层与字节数；未创建的层不出现。 */
  async usage(): Promise<TierUsage[]> {
    const out: TierUsage[] = [];
    const seen = new Set<string>();
    for (const store of this.#stores.values()) {
      if (seen.has(store.path)) continue;
      seen.add(store.path);
      out.push({
        tier: store.tier,
        path: store.path,
        bytes: await fileBytes(store.path),
      });
    }
    for (const tier of TIERS) {
      if (tier === "session") continue; // S 层按会话多库，只报已打开的
      const path = this.pathFor(tier);
      if (path === undefined || seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      out.push({ tier, path, bytes: await fileBytes(path) });
    }
    return out;
  }

  /** 跨层检索（只读）：按 `tier` 收窄可选；排序 = 层权重 → 同层分数。 */
  search(opts: SearchOptions & { tier?: Tier }): LayeredHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const hits: LayeredHit[] = [];
    for (const store of this.#stores.values()) {
      if (opts.tier !== undefined && store.tier !== opts.tier) continue;
      hits.push(...store.kb.search({ ...opts, limit }));
    }
    hits.sort((a, b) => {
      const byTier = TIER_WEIGHT[b.tier] - TIER_WEIGHT[a.tier];
      return byTier !== 0 ? byTier : a.score - b.score;
    });
    return hits.slice(0, limit);
  }

  /** 跨层列举（只读）：按 kind 逐库列举后合并，`created_at` 倒序分页。 */
  list(
    opts: Omit<ListOptions, "kind"> & { kind?: string; tier?: Tier },
  ): StoreRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
    const offset = Math.max(0, opts.offset ?? 0);
    const rows: StoreRow[] = [];
    for (const store of this.#stores.values()) {
      if (opts.tier !== undefined && store.tier !== opts.tier) continue;
      for (const kind of store.kb.kinds()) {
        if (opts.kind !== undefined && kind !== opts.kind) continue;
        rows.push(
          ...store.kb.listRows({
            kind,
            ...(opts.project === undefined ? {} : { project: opts.project }),
            limit: limit + offset,
          }),
        );
      }
    }
    rows.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    return rows.slice(offset, offset + limit);
  }

  /** 写入直落目标层（调用方已校验 `writableTiers`）；目标层不可用即抛错。 */
  async write(
    tier: Tier,
    input: PutInput,
    sessionId?: string,
  ): Promise<PutResult> {
    const store = await this.openWritable(tier, sessionId);
    return store.kb.put(input);
  }
  /** 删除（真删，返回条数）；只作用于已存在的层库，未创建 / 未打开的层视为无行。 */
  async forget(
    refs: readonly { tier: Tier; ids: readonly RowRef[]; sessionId?: string }[],
  ): Promise<number> {
    let removed = 0;
    for (const ref of refs) {
      const store = await this.openExisting(ref.tier, ref.sessionId);
      if (store === undefined) continue;
      removed += store.kb.evict(ref.ids);
    }
    return removed;
  }

  /** 各层首次打开的落点（日志 / 测试证据）。 */
  openedPaths(): ReadonlyArray<{ tier: Tier; path: string }> {
    return this.#opened;
  }

  close(): void {
    for (const store of this.#stores.values()) store.db.close();
    this.#stores.clear();
  }

  #register(
    tier: Tier,
    sessionId: string | undefined,
    path: string,
    db: DatabaseSync,
    project: string,
  ): TierStore {
    const kb = new KnowledgeService(db, {
      tier,
      ...(this.#rules === undefined ? {} : { rules: this.#rules }),
      ...(this.#registry === undefined ? {} : { registry: this.#registry }),
    });
    const store: TierStore = { tier, path, db, kb, project };
    this.#stores.set(storeKey(tier, sessionId), store);
    this.#opened.push({ tier, path });
    return store;
  }
}

/** 检索排序加权（设计 §7）：U > 当前项目 P > S。 */
export const TIER_WEIGHT: Record<Tier, number> = {
  user: 3,
  project: 2,
  session: 1,
};

/** 库键：S 层按库路径（= 会话），P / U 层各一份。 */
function storeKey(tier: Tier, sessionIdOrPath?: string): string {
  return tier === "session" ? `session\u0000${sessionIdOrPath ?? ""}` : tier;
}

/** 库文件的字节数（并了 WAL 主文件；文件不存在记 0）。 */
async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
