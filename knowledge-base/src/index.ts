/**
 * knowledge-base 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / provide / apply（无 inject），Config 以类型别名给出（无运行时 schema，宿主不校验，
 * 配置原样透传给 apply；缺省/非法值沿用本包既有语义，不新增校验）。
 * @deepseek-ai/cordis 为 dsh 仓库 workspace 包（未发布到 npm），宿主 ctx 用结构化类型声明；
 * createKnowledgeBundle 为核心工厂（可测/可复用），apply 为 DSH 宿主挂载入口。
 * ctx_knowledge 四接口 = KnowledgeService 的 search/put/touch/evict。
 */

import { openKnowledgeDatabase, type JournalMode } from "./schema.ts";
import { KnowledgeService } from "./knowledge.ts";
import { MemoryService } from "./memory.ts";
import { WritePolicy } from "./writepolicy.ts";
import { SessionHooks, type HookHost } from "./hooks.ts";
import {
  ConsolidationService,
  type ConsolidationOptions,
  type ConsolidationReport,
} from "./consolidate.ts";
import type { PersistRules } from "./rules.ts";

export {
  openKnowledgeDatabase,
  KnowledgeService,
  MemoryService,
  WritePolicy,
  SessionHooks,
  ConsolidationService,
};
export type {
  SearchHit,
  SearchOptions,
  PutInput,
  PutResult,
} from "./knowledge.ts";
export type { MemoryHit, MemorySearchResult, MemoryTarget } from "./memory.ts";
export type { WriteBackResult, EvictResult } from "./writepolicy.ts";
export type { PersistRules, SkipReason, RuleVerdict } from "./rules.ts";
export type { BudgetEnforcement, BudgetGuardOptions } from "./budget.ts";
export type {
  ConsolidationOptions,
  ConsolidationReport,
} from "./consolidate.ts";
export type { IngestOutcome, IngestStats, IngestSkip } from "./hooks.ts";

export const name = "knowledge-base";
/** 只读查询面挂载声明（BACKLOG C4 补全：TUI /memory 经 ctx.get('knowledge') 接线） */
export const provide = ["knowledge"];

/** 结构化宿主 ctx（DSH cordis 最小形态）：session/event 事件 + 可选 logger。 */
export interface BundleHost extends HookHost {
  logger?(ns: string): { info(message: string): void };
}

export interface KnowledgeConfig {
  /** 独立 SQLite 库路径；缺省取 KNOWLEDGE_DB_PATH 环境变量，再缺省为 :memory:。 */
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
  const dbPath = config.dbPath ?? process.env.KNOWLEDGE_DB_PATH ?? ":memory:";
  const db = await openKnowledgeDatabase(dbPath, config.journalMode);
  const kb = new KnowledgeService(db);
  const memory = new MemoryService(db);
  const policy = new WritePolicy(kb);
  const consolidate = new ConsolidationService(kb);
  const log = (message: string): void => {
    host.logger?.(name).info(message);
  };
  const hooks = new SessionHooks(kb, {
    project: config.project ?? "default",
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
    log(`knowledge-base 非法拒绝模式已忽略：${hooks.rules.invalid.join(", ")}`);
  }

  // —— 自动巩固：启动后一次 + compaction 完成后（进程内节流；只对静态 project 生效）——
  const projectName =
    typeof config.project === "string" ? config.project : "default";
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
        `knowledge-base 自动巩固（${reason}）：提升 ${report.promoted.length} / 合并 ${report.merged.length} / 压缩 ${report.compressed} / 淘汰 ${report.evicted}`,
      );
      return report;
    } catch (error: unknown) {
      log(`knowledge-base 自动巩固失败（忽略）：${String(error)}`);
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
    `knowledge-base 已就绪（db=${dbPath === ":memory:" ? ":memory:" : dbPath}）`,
  );
  const summary = (): KnowledgeBundleSummary => {
    const chunks = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
      n: number;
    };
    const sources = db.prepare("SELECT COUNT(*) AS n FROM sources").get() as {
      n: number;
    };
    return {
      ready: true,
      dbPath,
      chunkCount: Number(chunks.n),
      sourceCount: Number(sources.n),
    };
  };
  return {
    kb,
    memory,
    policy,
    hooks,
    consolidate,
    project: projectName,
    dbPath,
    summary,
    dispose: () => {
      detach();
      detachConsolidate();
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
    return Promise.reject(
      new Error("knowledge-base 尚未初始化（apply 未调用）"),
    );
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
      ctx.logger?.(name).info(`knowledge-base 启动失败：${String(error)}`);
    },
  );
  // 只读查询面挂到 ctx（防御式，与 task-engine/metric-loop/security-guard 同款）：
  // 供 TUI /memory 接线（查询概要 / 等待就绪）
  const provideSvc = (
    ctx as { provide?: (name: string, value: unknown) => unknown }
  ).provide;
  if (typeof provideSvc === "function") {
    provideSvc("knowledge", {
      getSummary: () => getKnowledgeBundleSummary(),
      whenReady: () => whenKnowledgeReady(),
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
