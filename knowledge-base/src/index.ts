/**
 * knowledge-base 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 DSH-CTX-API.md §0：插件 bundle 约定 `export { name, inject, Config, apply }`。
 * @deepseek-ai/cordis 为 dsh 仓库 workspace 包（未发布到 npm），宿主 ctx 用结构化类型声明；
 * createKnowledgeBundle 为核心工厂（可测/可复用），apply 为 DSH 宿主挂载入口。
 * ctx_knowledge 四接口 = KnowledgeService 的 search/put/touch/evict。
 */

import { openKnowledgeDatabase, type JournalMode } from "./schema.ts";
import { KnowledgeService } from "./knowledge.ts";
import { MemoryService } from "./memory.ts";
import { WritePolicy } from "./writepolicy.ts";
import { SessionHooks, type HookHost } from "./hooks.ts";

export {
  openKnowledgeDatabase,
  KnowledgeService,
  MemoryService,
  WritePolicy,
  SessionHooks,
};
export type {
  SearchHit,
  SearchOptions,
  PutInput,
  PutResult,
} from "./knowledge.ts";
export type { MemoryHit, MemorySearchResult, MemoryTarget } from "./memory.ts";
export type { WriteBackResult, EvictResult } from "./writepolicy.ts";

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
}

export interface KnowledgeBundle {
  kb: KnowledgeService;
  memory: MemoryService;
  policy: WritePolicy;
  hooks: SessionHooks;
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
  const hooks = new SessionHooks(kb, {
    project: config.project ?? "default",
    persistTypes: config.persistTypes,
  });
  const detach = hooks.attach(host);
  host
    .logger?.(name)
    .info(
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
    dbPath,
    summary,
    dispose: () => {
      detach();
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
    });
  }
}
