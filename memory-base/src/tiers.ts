/**
 * 分层库集合（设计 §2 / §7 / §8）：S 会话 / P 项目 / U 用户三个库的打开、写入路由与跨全域检索。
 *
 * 不变量：
 * - **一库一指纹**（`schema.ts`）：层拿错即拒绝打开，旧 v1 库不会被自动读取；
 * - **写入路由**：自动路径唯一入口是 S；`origin: "user"` 可直达目标层（设计 §5）；
 * - **检索跨全域**：层 × 分类一起搜，排序 U > 当前项目 P > 其他项目 P > S（设计 §7）；
 * - **容量按字节**（`page_count × page_size`）；U 层软上限只告警（设计 §8）。
 */

import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openTierDatabase, type JournalMode } from "./schema.ts";
import {
  KnowledgeService,
  type PutInput,
  type PutResult,
  type SearchHit,
  type SearchOptions,
} from "./knowledge.ts";
import type { Tier, TierPaths } from "./router.ts";
import type { CompiledRules } from "./rules.ts";

/** 逐库字节上限（设计 §2 表）。 */
export const TIER_LIMIT_BYTES: Record<Tier, number> = {
  session: 50 * 1024 * 1024,
  project: 200 * 1024 * 1024,
  /** 软上限：超限只告警，不拒写、不自动淘汰。 */
  user: 1 * 1024 * 1024,
};

/** 检索排序加权（设计 §7）：U > 当前项目 P > 其他项目 P > S。 */
export const TIER_WEIGHT: Record<Tier, number> = {
  user: 3,
  project: 2,
  session: 1,
};

/** 一个已打开的层库。 */
export interface TierStore {
  tier: Tier;
  /** 文件路径或 `:memory:`。 */
  path: string;
  db: DatabaseSync;
  kb: KnowledgeService;
  /** 该库所在项目的键（P 层有意义；S / U 为空串）。 */
  project: string;
  /** 是否当前项目（跨项目打开时为 false）。 */
  current: boolean;
}

/**
 * 库的字节用量（设计 §8 口径：`page_count × page_size`）。
 * 扣除 `freelist_count`（删除后文件不缩、空闲页会被后续写入复用），否则淘汰后仍"超限"。
 */
export function tierUsageBytes(db: DatabaseSync): number {
  const pageCount = (
    db.prepare("PRAGMA page_count").get() as {
      page_count: number;
    }
  ).page_count;
  const freePages = (
    db.prepare("PRAGMA freelist_count").get() as {
      freelist_count: number;
    }
  ).freelist_count;
  const pageSize = (
    db.prepare("PRAGMA page_size").get() as {
      page_size: number;
    }
  ).page_size;
  return Math.max(0, Number(pageCount) - Number(freePages)) * Number(pageSize);
}

/** 每轮淘汰 / 降级的批大小。 */
const EVICT_STEP = 10;

export interface TierUsage {
  tier: Tier;
  path: string;
  bytes: number;
  limitBytes: number;
  over: boolean;
  /** U 层超限只告警，不触发淘汰。 */
  soft: boolean;
}

/** 一次容量兜底执行的逐层结果（设计 §5「可观测」）。 */
export interface TierEnforcement extends TierUsage {
  /** 就地压缩降级的条数（只 S 层会 > 0）。 */
  demoted: number;
  /** 硬淘汰的条数。 */
  evicted: number;
}

/** 跨层检索命中：单库命中 + 层身份。 */
export type LayeredHit = SearchHit & { tier: Tier };

export interface LayeredSearchOptions extends SearchOptions {
  /** 收窄到某一层；缺省跨全部已打开层。 */
  tier?: Tier;
  /** 每层检索上限（缺省沿用 `limit`）。 */
  perTierLimit?: number;
}

export interface RememberInput extends PutInput {
  /** 目标层；自动路径忽略它（一律落 S），只有 `origin: "user"` 可直达。 */
  tier?: Tier;
  /** `user` = 用户明确指令（免逐级提升）；缺省 `auto`。 */
  origin?: "auto" | "user";
}

/** 打开三库的入参。 */
export interface OpenTierSetOptions {
  paths: TierPaths;
  journalMode?: JournalMode;
  /** 当前项目键（P 库里的 project 值），缺省 `"default"`。 */
  projectKey?: string;
  /** 各层共用的入库闸门（设计 §5：闸门在库核心）；缺省只用内置隐私底线。 */
  rules?: CompiledRules;
  /**
   * 额外打开的「其他项目」P 库（`crossProject` 用，**只能由用户显式发起**）：
   * 值为项目根目录列表。
   */
  otherProjectRoots?: readonly string[];
}

/** 三库集合：打开、路由、检索、容量。 */
export class TierSet {
  readonly #stores: TierStore[];

  private constructor(stores: TierStore[]) {
    this.#stores = stores;
  }

  static async open(opts: OpenTierSetOptions): Promise<TierSet> {
    const journalMode = opts.journalMode ?? "wal";
    const stores: TierStore[] = [];
    const { paths } = opts;
    const projectKey = opts.projectKey ?? "default";

    if (paths.session !== undefined) {
      stores.push(
        await openStore(
          "session",
          paths.session,
          journalMode,
          "",
          true,
          opts.rules,
        ),
      );
    }
    if (paths.project !== undefined) {
      stores.push(
        await openStore(
          "project",
          paths.project,
          journalMode,
          projectKey,
          true,
          opts.rules,
        ),
      );
    }
    for (const root of opts.otherProjectRoots ?? []) {
      const path = join(root, ".dsh", "project.db");
      stores.push(
        await openStore("project", path, journalMode, root, false, opts.rules),
      );
    }
    stores.push(
      await openStore("user", paths.user, journalMode, "", true, opts.rules),
    );
    return new TierSet(stores);
  }

  /** 该层的库（同层多库时取第一个；「其他项目」用 `projects()` 取全）。 */
  get(tier: Tier): TierStore | undefined {
    return this.#stores.find((store) => store.tier === tier);
  }

  /** 当前项目层的库。 */
  currentProject(): TierStore | undefined {
    return this.#stores.find(
      (store) => store.tier === "project" && store.current,
    );
  }

  /** 全部已打开库（含跨项目 P）。 */
  all(): readonly TierStore[] {
    return this.#stores;
  }

  /** 各库字节用量与是否超限（U 层 `soft: true` 只告警）。 */
  usage(): TierUsage[] {
    return this.#stores.map((store) => {
      const bytes = tierUsageBytes(store.db);
      const limitBytes = TIER_LIMIT_BYTES[store.tier];
      return {
        tier: store.tier,
        path: store.path,
        bytes,
        limitBytes,
        over: bytes > limitBytes,
        soft: store.tier === "user",
      };
    });
  }

  /**
   * 逐库容量兜底（设计 §8）：**S 层先就地压缩降级、仍超限才硬淘汰**；P 层直接淘汰；
   * **U 层是软上限——只告警不淘汰**（记忆不因容量被静默丢弃）。返回执行后的用量快照。
   */
  enforceLimits(
    opts: { limitBytes?: Partial<Record<Tier, number>> } = {},
  ): TierEnforcement[] {
    const report: TierEnforcement[] = [];
    for (const store of this.#stores) {
      const limit =
        opts.limitBytes?.[store.tier] ?? TIER_LIMIT_BYTES[store.tier];
      const bytes = tierUsageBytes(store.db);
      let demoted = 0;
      let evicted = 0;
      if (store.tier !== "user" && bytes > limit) {
        // 按缺口淘汰：用「平均每条字节」把缺口折算成条数，删够即止。
        // 不拿字节做收敛判据——WAL 下删行不缩文件、FTS5 删除是标记删除，字节不会立刻下降。
        const rows = Number(
          (
            store.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
              n: number;
            }
          ).n,
        );
        const average = rows > 0 ? bytes / rows : 0;
        const gap = (): number =>
          average > 0
            ? Math.max(
                0,
                Math.ceil((tierUsageBytes(store.db) - limit) / average),
              )
            : EVICT_STEP;
        if (store.tier === "session") {
          // 第一段：就地压缩降级（只挑尚未压缩、importance < 5 的行）。
          let budget = gap();
          while (budget > 0) {
            const ids = store.kb.demotionCandidates({
              limit: Math.min(EVICT_STEP, budget),
            });
            if (ids.length === 0) break;
            demoted += store.kb.compress(ids);
            budget -= ids.length;
          }
        }
        // 第二段：硬淘汰（importance → last_referenced → id）。
        let remaining = gap();
        while (remaining > 0) {
          const ids = store.kb.evictionCandidates({
            limit: Math.min(EVICT_STEP, remaining),
          });
          if (ids.length === 0) break;
          evicted += store.kb.evict(ids);
          remaining -= ids.length;
        }
      }
      report.push({
        tier: store.tier,
        path: store.path,
        bytes: tierUsageBytes(store.db),
        limitBytes: limit,
        over: tierUsageBytes(store.db) > limit,
        soft: store.tier === "user",
        demoted,
        evicted,
      });
    }
    return report;
  }

  /**
   * 跨层检索（设计 §7）：默认覆盖全部已打开层，排序 = 层权重 → 同项目优先 → 分数。
   * `tier` 收窄到单层；P 的跨项目库是否参与由 `open()` 时是否传入决定（不在这里开）。
   */
  search(opts: LayeredSearchOptions): LayeredHit[] {
    const limit = Math.max(1, opts.limit ?? 10);
    const perTier = Math.max(1, opts.perTierLimit ?? limit);
    const hits: LayeredHit[] = [];
    for (const store of this.#stores) {
      if (opts.tier !== undefined && store.tier !== opts.tier) continue;
      const rows = store.kb.search({ ...opts, limit: perTier });
      for (const row of rows) hits.push({ ...row, tier: store.tier });
    }
    hits.sort((a, b) => {
      const byTier = TIER_WEIGHT[b.tier] - TIER_WEIGHT[a.tier];
      if (byTier !== 0) return byTier;
      return a.score - b.score;
    });
    return hits.slice(0, limit);
  }

  /**
   * 写入路由（设计 §5）：自动路径唯一入口 = S；`origin: "user"` 可直达 P / U。
   * 目标层没有已打开的库 → 抛错（不静默改写别处）。
   */
  remember(input: RememberInput): PutResult {
    const target =
      input.origin === "user" && input.tier !== undefined
        ? input.tier
        : "session";
    const store =
      target === "project"
        ? (this.currentProject() ?? this.get("project"))
        : this.get(target);
    if (store === undefined) {
      throw new Error(
        `memory-base 没有可写的 ${target} 库（该层未打开；自动路径只能写会话层）`,
      );
    }
    const { tier: _tier, origin: _origin, ...put } = input;
    return store.kb.put(put);
  }

  /** 删除（设计 §6.1：删除是独立动作，不传播到下层来源行）。 */
  forget(refs: readonly { tier: Tier; ids: readonly number[] }[]): number {
    let removed = 0;
    for (const ref of refs) {
      const store = this.get(ref.tier);
      if (store === undefined) continue;
      removed += store.kb.evict([...ref.ids]);
    }
    return removed;
  }

  close(): void {
    for (const store of this.#stores) store.db.close();
  }
}

async function openStore(
  tier: Tier,
  path: string,
  journalMode: JournalMode,
  project: string,
  current: boolean,
  rules: CompiledRules | undefined,
): Promise<TierStore> {
  const db = await openTierDatabase(path, tier, journalMode);
  const kb = new KnowledgeService(db, rules === undefined ? {} : { rules });
  return { tier, path, db, kb, project, current };
}
