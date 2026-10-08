/**
 * memory-base 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / provide / apply（无 inject），Config 以类型别名给出（无运行时 schema，宿主不校验，
 * 配置原样透传给 apply；缺省/非法值沿用本包既有语义，不新增校验）。
 * @deepseek-ai/cordis 为 dsh 仓库 workspace 包（未发布到 npm），宿主 ctx 用结构化类型声明；
 * createKnowledgeBundle 为核心工厂（可测/可复用），apply 为 DSH 宿主挂载入口。
 * ctx_knowledge 四接口 = KnowledgeService 的 search/put/touch/evict。
 */

import { openKnowledgeDatabase, type JournalMode } from "./schema.ts";
import {
  migrate,
  type MigrateFrom,
  type MigrateMode,
  type MigrateResult,
} from "./migrate.ts";
import {
  KnowledgeService,
  type RescanReport,
  type RowRef,
} from "./knowledge.ts";
import { MemoryService } from "./memory.ts";
import { WritePolicy } from "./writepolicy.ts";
import { SessionHooks, type HookHost } from "./hooks.ts";
import {
  ConsolidationService,
  type ConsolidationOptions,
  type ConsolidationReport,
} from "./consolidate.ts";
import type { PersistRules } from "./rules.ts";
import {
  TierSet,
  type LayeredHit,
  type LayeredSearchOptions,
  type RememberInput,
  type TierEnforcement,
  type TierUsage,
} from "./tiers.ts";
import { resolveTierPaths, type Tier } from "./router.ts";
import {
  fallbackSpec,
  KindRegistry,
  type KindSpec,
  type RegisteredKind,
} from "./router.ts";

export {
  openKnowledgeDatabase,
  KnowledgeService,
  MemoryService,
  WritePolicy,
  SessionHooks,
  ConsolidationService,
  migrate,
  fallbackSpec,
  KindRegistry,
};
export type {
  DeniedRow,
  PutInput,
  PutResult,
  RescanReport,
  RowRef,
  SearchHit,
  SearchOptions,
} from "./knowledge.ts";
export type { KindColumn, KindSpec, RegisteredKind } from "./router.ts";
export type { MemoryHit, MemorySearchResult, MemoryTarget } from "./memory.ts";
export type { WriteBackResult, EvictResult } from "./writepolicy.ts";
export type { PersistRules, SkipReason, RuleVerdict } from "./rules.ts";
export type { BudgetEnforcement, BudgetGuardOptions } from "./budget.ts";
export type {
  ConsolidationOptions,
  ConsolidationReport,
} from "./consolidate.ts";
export type { IngestOutcome, IngestStats, IngestSkip } from "./hooks.ts";
export type {
  MigrateFrom,
  MigrateInput,
  MigrateMode,
  MigrateResult,
} from "./migrate.ts";

export const name = "memory-base";
/** 只读查询面挂载声明（BACKLOG C4 补全：TUI /memory 经 ctx.get('memory') 接线） */
export const provide = ["memory"];

/** 结构化宿主 ctx（DSH cordis 最小形态）：session/event 事件 + 可选 logger。 */
export interface BundleHost extends HookHost {
  logger?(ns: string): { info(message: string): void };
}

export interface KnowledgeConfig {
  /** 独立 SQLite 库路径；缺省取 MEMORY_DB_PATH 环境变量，再缺省为 :memory:。 */
  dbPath?: string;
  journalMode?: JournalMode;
  /** 写直达事件的项目作用域（静态或按事件求值）。 */
  project?: string | (() => string);
  persistTypes?: ReadonlySet<string> | null;
  /** 入库过滤规则（类型 / 最小长度 / 拒绝模式，含内置隐私模式）：见 `rules.ts`。 */
  persistRules?: PersistRules;
  /** 入库容量守卫：project 估算 token 超限时先压缩降级再淘汰（缺省 0 = 不设限）。 */
  maxTokensPerProject?: number;
  /** 自动巩固（BACKLOG「记忆 auto-consolidation」）：见 `AutoConsolidateConfig`。 */
  autoConsolidate?: AutoConsolidateConfig;
  /**
   * 兜底分类名（设计 §4：名字来自配置，缺省 `default`）：未指定 `kind` 的写入落它，
   * 本包不为它赋予语义；其物理表固定为 v1 布局的 `chunks`（决策 D38）。
   */
  defaultKind?: string;
  /**
   * 分层三库（设计 §2 / §12 #10）：开启后 S / P / U 各一个库、各带独立指纹与字节上限。
   * **缺省关闭**——沿用单库 `dbPath`（不静默在项目里建 `.dsh/`、不在家目录建库）。
   */
  tiers?: TierConfig;
}

/** 分层三库的落点配置（`enabled: true` 才生效）。 */
export interface TierConfig {
  /** 总开关（缺省 false）。 */
  enabled?: boolean;
  /** S 库所在会话目录；缺省沿用 `dbPath`（或 `:memory:`）。 */
  sessionDir?: string;
  /** P 库所在项目根；缺省 `process.cwd()`。 */
  projectRoot?: string;
  /** 存储根（U 库落点 `<dshHome>/memory-base/user.db`）；缺省 `~/.dsh`。 */
  dshHome?: string;
  /**
   * 额外允许读的其他项目根（`crossProject`）：**只能由用户显式发起**，
   * agent 不得自行开启（设计 §7）。
   */
  crossProjectRoots?: readonly string[];
}

/** 自动巩固触发配置（巩固内容为「提升 + 合并相似 + 淘汰陈旧 + 容量守卫」）。 */
export interface AutoConsolidateConfig {
  /** 总开关（缺省 true）。 */
  enabled?: boolean;
  /** apply 后跑一次（缺省 true）。 */
  onStart?: boolean;
  /** `compaction` 完成后跑一次（缺省 true，受 `minIntervalMs` 节流）。 */
  afterCompaction?: boolean;
  /** 节流窗口（ms，缺省 10 分钟）：窗口内的触发只跳过，不排队。 */
  minIntervalMs?: number;
  /** 传给巩固的段参数（`limit` / `ttlMs` / `maxImportance` / `maxTokens` / 段开关）。 */
  options?: Omit<ConsolidationOptions, "project">;
}

/**
 * Config 契约别名（DSH bundle §0 的 `Config`）：仅类型级导出，不新增运行时 schema——
 * cordis `resolveConfig()` 只在本导出带 `'~standard'` 校验接口时才校验配置，无 schema 即
 * 原样透传，故不改变本包既有的缺省链回退/启动失败只告警语义（避免 fail-closed 改变行为）。
 */
export type Config = KnowledgeConfig;

export interface KnowledgeBundle {
  kb: KnowledgeService;
  memory: MemoryService;
  policy: WritePolicy;
  hooks: SessionHooks;
  /** 巩固服务（提升 / 合并 / 淘汰 + 容量守卫），`plan()` 可只读预演。 */
  consolidate: ConsolidationService;
  /** 分类注册表（设计 §4）：第三方经服务面 `registerKind` 注册，各层库共用。 */
  registry: KindRegistry;
  /** 分层三库集合（`config.tiers.enabled` 时才有）：跨层检索 / 写入路由 / 容量。 */
  tiers?: TierSet;
  /** 静态项目作用域；`project` 配成函数时为 `"default"`（自动巩固只用静态值）。 */
  project: string;
  /** 实际数据库路径（:memory: 或文件路径）。 */
  dbPath: string;
  /** 概要：就绪状态 + 库路径 + 条目统计（当前活跃实例）。 */
  summary(): KnowledgeBundleSummary;
  /** 解绑事件订阅并关闭数据库连接。 */
  dispose(): void;
}

export interface KnowledgeBundleSummary {
  /** 是否就绪（bundle 已创建且可用）。 */
  ready: boolean;
  /** 实际数据库路径（:memory: 或文件路径）。 */
  dbPath: string;
  /** chunks 条数。 */
  chunkCount: number;
  /** sources 条数。 */
  sourceCount: number;
}

/** 核心工厂：开库 → 建服务 → 挂事件 → 返回可释放的 bundle。 */
export async function createKnowledgeBundle(
  host: BundleHost,
  config: KnowledgeConfig = {},
): Promise<KnowledgeBundle> {
  const dbPath = config.dbPath ?? process.env.MEMORY_DB_PATH ?? ":memory:";
  const db = await openKnowledgeDatabase(dbPath, config.journalMode);
  // 分类注册表（设计 §4）：进程内一份、各层库共用；兜底分类由配置声明并在此注册。
  const registry = new KindRegistry({
    ...(config.defaultKind === undefined
      ? {}
      : { fallbackKind: config.defaultKind }),
  });
  registry.register(fallbackSpec(registry.fallbackKind));
  const kb = new KnowledgeService(db, { registry });
  const memory = new MemoryService(db);
  const policy = new WritePolicy(kb);
  const consolidate = new ConsolidationService(kb);
  const log = (message: string): void => {
    host.logger?.(name).info(message);
  };
  const hooks = new SessionHooks(kb, {
    // 不填 "default"：交给派生链（显式配置 > 会话 header.cwd > process.cwd()，设计 §7）。
    ...(config.project === undefined ? {} : { project: config.project }),
    persistTypes: config.persistTypes,
    ...(config.persistRules === undefined
      ? {}
      : { rules: config.persistRules }),
    ...(config.maxTokensPerProject === undefined ||
    config.maxTokensPerProject <= 0
      ? {}
      : { budget: { maxTokens: config.maxTokensPerProject } }),
  });
  const detach = hooks.attach(host);
  if (hooks.rules.invalid.length > 0) {
    log(`memory-base 非法拒绝模式已忽略：${hooks.rules.invalid.join(", ")}`);
  }

  // —— 自动巩固：启动后一次 + compaction 完成后（进程内节流；只对静态 project 生效）——
  // 自动巩固只认静态作用域：显式配置优先，否则用进程 cwd（与写入侧的派生链首项一致）。
  const projectName =
    typeof config.project === "string" ? config.project : process.cwd();

  // —— 分层三库（设计 §2）：显式开启才建 P / U 库，避免在项目里静默留 .dsh/ ——
  const tierConfig = config.tiers;
  let tiers: TierSet | undefined;
  if (tierConfig?.enabled === true) {
    const paths = resolveTierPaths({
      ...(tierConfig.sessionDir === undefined
        ? {}
        : { sessionDir: tierConfig.sessionDir }),
      projectRoot: tierConfig.projectRoot ?? process.cwd(),
      ...(tierConfig.dshHome === undefined
        ? {}
        : { dshHome: tierConfig.dshHome }),
    });
    // 显式 dbPath 优先作为会话库（未给会话目录时），保持既有单库部署的落点不变。
    if (tierConfig.sessionDir === undefined) paths.session = dbPath;
    tiers = await TierSet.open({
      paths,
      ...(config.journalMode === undefined
        ? {}
        : { journalMode: config.journalMode }),
      projectKey: projectName,
      // 闸门在库核心（设计 §5）：把事件钩子编译好的规则交给各层库，绕过钩子的写路径同样受管。
      rules: hooks.rules,
      // 分类注册表跨层共用（设计 §4「跨层同构」）；U 层库禁止落兜底（§5）。
      registry,
      ...(tierConfig.crossProjectRoots === undefined
        ? {}
        : { otherProjectRoots: tierConfig.crossProjectRoots }),
    });
    log(
      `memory-base 分层三库已开启（${tiers
        .all()
        .map(
          (store) => `${store.tier}${store.current ? "" : "*"}=${store.path}`,
        )
        .join(" / ")}）`,
    );
  }
  const auto = config.autoConsolidate ?? {};
  const minIntervalMs = Math.max(0, auto.minIntervalMs ?? 10 * 60 * 1000);
  let lastConsolidateAt = 0;
  const maybeConsolidate = (
    reason: string,
  ): ConsolidationReport | undefined => {
    if (auto.enabled === false) return undefined;
    const at = Date.now();
    if (at - lastConsolidateAt < minIntervalMs) return undefined;
    lastConsolidateAt = at;
    try {
      const report = consolidate.run({
        project: projectName,
        maxTokens: config.maxTokensPerProject ?? 0,
        ...(auto.options ?? {}),
      });
      log(
        `memory-base 自动巩固（${reason}）：提升 ${report.promoted.length} / 合并 ${report.merged.length} / 压缩 ${report.compressed} / 淘汰 ${report.evicted}`,
      );
      // 逐库容量兜底（设计 §8：触发点 = 写入后 + 巩固时）；U 层只告警。
      if (tiers !== undefined) {
        const enforcement = tiers.enforceLimits();
        for (const entry of enforcement) {
          if (entry.evicted > 0 || entry.demoted > 0) {
            log(
              `memory-base 容量兜底（${entry.tier}）：降级 ${entry.demoted} / 淘汰 ${entry.evicted}（${entry.bytes}/${entry.limitBytes} 字节）`,
            );
          } else if (entry.over) {
            log(
              `memory-base 容量告警（${entry.tier}${entry.soft ? "，软上限" : ""}）：${entry.bytes}/${entry.limitBytes} 字节`,
            );
          }
        }
      }
      return report;
    } catch (error: unknown) {
      log(`memory-base 自动巩固失败（忽略）：${String(error)}`);
      return undefined;
    }
  };
  const consolidateDisposer = host.on("session/event", (_session, event) => {
    if (auto.afterCompaction === false) return;
    if (
      event?.type === "compaction/end" ||
      event?.type === "compaction/summary"
    ) {
      maybeConsolidate("compaction");
    }
  });
  const detachConsolidate =
    typeof consolidateDisposer === "function" ? consolidateDisposer : () => {};
  if (auto.onStart !== false) maybeConsolidate("start");
  log(
    `memory-base 已就绪（db=${dbPath === ":memory:" ? ":memory:" : dbPath}）`,
  );
  const summary = (): KnowledgeBundleSummary => {
    const sources = db.prepare("SELECT COUNT(*) AS n FROM sources").get() as {
      n: number;
    };
    return {
      ready: true,
      dbPath,
      chunkCount: kb.countAll(),
      sourceCount: Number(sources.n),
    };
  };
  return {
    kb,
    memory,
    policy,
    hooks,
    consolidate,
    registry,
    ...(tiers === undefined ? {} : { tiers }),
    project: projectName,
    dbPath,
    summary,
    dispose: () => {
      detach();
      detachConsolidate();
      tiers?.close();
      db.close();
    },
  };
}

/** 最近一次成功创建的知识库 bundle（apply 持有，供命令侧查询/调用）。 */
let activeBundle: KnowledgeBundle | undefined;
/** 最近一次 apply 的创建 Promise（供 whenKnowledgeReady 等待）。 */
let readyPromise: Promise<KnowledgeBundle> | undefined;

/** 同步查询当前已建 bundle；未就绪（未 apply 或启动失败）时返回 undefined。 */
export function getKnowledgeBundle(): KnowledgeBundle | undefined {
  return activeBundle;
}

/** 查询已建 bundle 概要；未就绪时返回 undefined。 */
export function getKnowledgeBundleSummary():
  KnowledgeBundleSummary | undefined {
  return activeBundle?.summary();
}

/**
 * 等待知识库就绪（apply 已调用后 resolve 已建 bundle）。
 * 调用时机不确定时用此入口，避免竞态；启动失败时 reject。
 */
export function whenKnowledgeReady(): Promise<KnowledgeBundle> {
  const pending = readyPromise;
  if (pending === undefined) {
    return Promise.reject(new Error("memory-base 尚未初始化（apply 未调用）"));
  }
  return pending;
}

/** DSH 宿主按 bundle 契约调用（结构化 ctx；真实宿主联调在部署时人工确认）。 */
export function apply(ctx: BundleHost, config: KnowledgeConfig = {}): void {
  const pending = createKnowledgeBundle(ctx, config);
  readyPromise = pending;
  pending.then(
    (bundle) => {
      activeBundle = bundle;
    },
    (error: unknown) => {
      ctx.logger?.(name).info(`memory-base 启动失败：${String(error)}`);
    },
  );
  // 只读查询面挂到 ctx（防御式，与 task-engine/metric-loop/security-guard 同款）：
  // 供 TUI /memory 接线（查询概要 / 等待就绪）
  const provideSvc = (
    ctx as { provide?: (name: string, value: unknown) => unknown }
  ).provide;
  if (typeof provideSvc === "function") {
    provideSvc("memory", {
      getSummary: () => getKnowledgeBundleSummary(),
      whenReady: () => whenKnowledgeReady(),
      /**
       * 存量迁移（设计 §10）：显式调用才执行，不静默删。
       * 缺省作用于本 bundle 的库路径；当前只有 from=v1 / mode=drop。
       */
      migrate: (opts?: {
        dbPath?: string;
        from?: MigrateFrom;
        mode?: MigrateMode;
      }): Promise<MigrateResult> => {
        const target =
          opts?.dbPath ?? config.dbPath ?? process.env.MEMORY_DB_PATH;
        if (target === undefined || target === ":memory:") {
          return Promise.reject(
            new Error(
              "memory-base 无文件库路径可迁移（请在 config.dbPath 或 MEMORY_DB_PATH 指定）",
            ),
          );
        }
        return migrate({
          dbPath: target,
          from: opts?.from ?? "v1",
          mode: opts?.mode ?? "drop",
        });
      },
      /** 存量回扫（设计 §5）：默认只报告条数与分类分布，`apply: true` 才删。 */
      rescanDenied: async (opts?: {
        project?: string;
        apply?: boolean;
      }): Promise<RescanReport> => {
        const bundle = await whenKnowledgeReady();
        return bundle.kb.rescanDenied({
          ...(opts ?? {}),
          rules: bundle.hooks.rules,
        });
      },
      /**
       * 分类注册（设计 §4）：第三方插件在自身 apply 时调用，声明 `kind` + 表名 + 扩展列 +
       * 事件认领 + 写前钩子 + 查询路由。同名 / 同表重复注册抛错；注册后**按需建表**（首次写入时）。
       */
      registerKind: async (spec: KindSpec): Promise<RegisteredKind> => {
        const bundle = await whenKnowledgeReady();
        const entry = bundle.registry.register(spec);
        return entry;
      },
      /** 跨层检索（设计 §7）：三库开启时层 × 分类跨全域；否则回落单库检索。 */
      search: async (opts: LayeredSearchOptions): Promise<LayeredHit[]> => {
        const bundle = await whenKnowledgeReady();
        return bundle.tiers === undefined
          ? bundle.kb
              .search(opts)
              .map((hit) => ({ ...hit, tier: "session" as const }))
          : bundle.tiers.search(opts);
      },
      /** 写入（设计 §5）：自动路径落 S；`origin: "user"` 可直达 P / U。 */
      remember: async (input: RememberInput) => {
        const bundle = await whenKnowledgeReady();
        return bundle.tiers === undefined
          ? bundle.kb.put(input)
          : bundle.tiers.remember(input);
      },
      /** 删除（设计 §6.1：独立动作，不传播到下层来源行）。 */
      forget: async (
        refs: readonly { tier: Tier; ids: readonly (number | RowRef)[] }[],
      ): Promise<number> => {
        const bundle = await whenKnowledgeReady();
        return bundle.tiers?.forget(refs) ?? 0;
      },
      /** 逐库字节用量与上限（设计 §8）。 */
      usage: async (): Promise<TierUsage[]> => {
        const bundle = await whenKnowledgeReady();
        return bundle.tiers?.usage() ?? [];
      },
      /** 逐库容量兜底（设计 §8）：S 先降级再淘汰、P 直接淘汰、U 只告警。 */
      enforceLimits: async (opts?: {
        limitBytes?: Partial<Record<Tier, number>>;
      }): Promise<TierEnforcement[]> => {
        const bundle = await whenKnowledgeReady();
        return bundle.tiers?.enforceLimits(opts ?? {}) ?? [];
      },
      /** 手动触发一次巩固（缺省按 bundle 的静态 project；可传段参数覆盖）。 */
      consolidate: async (opts?: Partial<ConsolidationOptions>) => {
        const bundle = await whenKnowledgeReady();
        return bundle.consolidate.run({
          project: bundle.project,
          ...(opts ?? {}),
        } as ConsolidationOptions);
      },
      /** 最近一次自动 / 手动巩固的报告。 */
      lastConsolidation: () => getKnowledgeBundle()?.consolidate.last,
    });
  }
}
