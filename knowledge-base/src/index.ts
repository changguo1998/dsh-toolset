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
  /** 解绑事件订阅并关闭数据库连接。 */
  dispose(): void;
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
  return {
    kb,
    memory,
    policy,
    hooks,
    dispose: () => {
      detach();
      db.close();
    },
  };
}

/** DSH 宿主按 bundle 契约调用（结构化 ctx；真实宿主联调在部署时人工确认）。 */
export function apply(ctx: BundleHost, config: KnowledgeConfig = {}): void {
  void createKnowledgeBundle(ctx, config).catch((error: unknown) => {
    ctx.logger?.(name).info(`knowledge-base 启动失败：${String(error)}`);
  });
}
