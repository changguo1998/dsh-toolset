/**
 * memory-base 插件入口（DSH bundle 接入面）。
 *
 * 口径（2026-10-17 接口重设）：本包只保留**分层 / 分类 / 读写 / 查询 / 按扩展隔离**五件事。
 * - 全局面（`ctx.get("memory")`）八键，**无任何写入与删除**：`registerKind` / `checkPrivacy` /
 *   `getSummary` / `whenReady` / `usage` / `migrate` / `list` / `search`；
 * - 写侧只经 `registerKind(spec)` 返回的作用域句柄（`MemoryScope`，见 `scope.ts`）；
 * - 层级恒开启、库惰性创建；S 层落点经宿主的 `sessionPaths.sessionDirFor(sessionId)` 解析；
 * - 模型侧只注册一个只读查询工具 `memory_query`（写权限留在各扩展的句柄上）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：`Config` 以类型
 * 别名给出（无运行时 schema，宿主不校验）；`@deepseek-ai/cordis` 为 dsh 仓库 workspace 包，宿主
 * ctx 用结构化类型声明。`createMemoryBundle` 为核心工厂（同步、可测/可复用），`apply` 为挂载入口。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { JournalMode } from "./schema.ts";
import {
  migrate,
  type MigrateFrom,
  type MigrateMode,
  type MigrateResult,
} from "./migrate.ts";
import type {
  KnowledgeService,
  ListOptions,
  SearchHit,
  SearchOptions,
  StoreRow,
} from "./knowledge.ts";
import { compileRules, matchDenyPattern, type PersistRules } from "./rules.ts";
import { KindRegistry, TIERS, type KindSpec, type Tier } from "./router.ts";
import { TierSet, type SessionPathsLike, type TierUsage } from "./tiers.ts";
import {
  createMemoryScope,
  type MemoryScope,
  type ScopeHost,
} from "./scope.ts";
import { memoryQueryTool, type MemoryQueryExecutor } from "./tools.ts";

export { migrate, KindRegistry, memoryQueryTool };
export type { MemoryQueryExecutor, MemoryQueryResult } from "./tools.ts";
export type {
  ListOptions,
  PutInput,
  PutResult,
  RowRef,
  SearchHit,
  SearchOptions,
  SourceKind,
  SourceRef,
  StoreRow,
} from "./knowledge.ts";
export type { ForgetRef, MemoryScope, ScopePutInput } from "./scope.ts";
export type {
  KindSpec,
  KindVerdict,
  KindWriteInput,
  RegisteredKind,
  Tier,
} from "./router.ts";
export type { PersistRules, RuleVerdict, SkipReason } from "./rules.ts";
export type {
  MigrateFrom,
  MigrateInput,
  MigrateMode,
  MigrateResult,
} from "./migrate.ts";
export type { SessionPathsLike, TierStore, TierUsage } from "./tiers.ts";

export const name = "memory-base";
/** 只读查询面挂载声明：`ctx.get("memory")` 八键（见 `MemoryGlobalService`）。 */
export const provide = ["memory"];
/**
 * 注入面：`tools`（注册 `memory_query`）。`sessionPaths` **不注入**——它是可选读取
 * （未挂载时写会话层按明示例外报错，其余层照常），用 `ctx.get("sessionPaths")` 探测。
 */
export const inject = ["tools"];

/** 宿主 `session/event` 载荷的最小结构面（只取会话 id）。 */
interface SessionLike {
  id?: string;
}

/** 结构化宿主 ctx（DSH cordis 最小形态）：日志、服务暴露 / 读取、工具注册与事件订阅均可缺。 */
export interface BundleHost {
  logger?(ns: string): { info(message: string): void };
  /** `ctx.provide(name, value)`：暴露服务面（缺失时静默跳过）。 */
  provide?(name: string, value: unknown): unknown;
  /** `ctx.get(name)`：读取其他插件暴露的服务（本包只读 `sessionPaths`）。 */
  get?(name: string): unknown;
  /** `ctx.tools.register(def)`：注册模型侧工具（缺失时只告警，不注册）。 */
  tools?: { register(def: unknown): unknown };
  /** `ctx.on(event, listener)`：订阅宿主事件（缺失时跳过）。 */
  on?(
    event: string,
    listener: (session: SessionLike, event: unknown) => unknown,
  ): unknown;
}

/** 插件配置（Config 契约名）。 */
export interface KnowledgeConfig {
  /** U 库落点根（`<dshHome>/memory-base/user.db`）；缺省 `~/.dsh`。 */
  dshHome?: string;
  /** P 库落点根（`<projectRoot>/.dsh/project.db`）；缺省 `process.cwd()`。 */
  projectRoot?: string;
  /** 缺省归属项目键（句柄未给 `project` 时用）；缺省 `process.cwd()`。 */
  project?: string;
  journalMode?: JournalMode;
  /** 内容闸门（内置隐私模式 + 追加拒绝模式 / 最小长度）：见 `rules.ts`。 */
  persistRules?: PersistRules;
  /** `list` 的缺省上限（clamp 1..100，缺省 20）。 */
  listLimit?: number;
  /** `migrate` 作用的旧库路径；缺省 `~/.dsh/memory-base/memory.db`（v1 单库落点）。 */
  legacyDbPath?: string;
}

/**
 * Config 契约别名（DSH bundle §0 的 `Config`）：仅类型级导出，不新增运行时 schema——
 * cordis `resolveConfig()` 只在本导出带 `'~standard'` 校验接口时才校验配置，无 schema 即
 * 原样透传，故不改变本包既有的缺省链回退语义（避免 fail-closed 改变行为）。
 */
export type Config = KnowledgeConfig;

/** 全局面：八键，**无写与删**（写权限留在各扩展的句柄上）。 */
export interface MemoryGlobalService {
  /** 注册分类并拿到写入句柄（同步；表在首次写入时按需建）。 */
  registerKind(spec: KindSpec): MemoryScope;
  /** 隐私底线查询（内置 + 配置追加）：命中返回模式源串，未命中 `null`。 */
  checkPrivacy(text: string): string | null;
  /** 概要：就绪状态 + 各层落点 + 已注册分类与条目统计。 */
  getSummary(): MemoryBundleSummary;
  /** 等待 bundle 就绪（同步创建，故恒 resolve）。 */
  whenReady(): Promise<MemoryBundle>;
  /** 只读用量：只报**已创建**的库（逐库容量上限已取消）。 */
  usage(): Promise<TierUsage[]>;
  /** 存量清理：删除旧库文件（当前只有 `from: "v1"` / `mode: "drop"`）。 */
  migrate(opts: {
    from: MigrateFrom;
    mode: MigrateMode;
  }): Promise<MigrateResult>;
  /** 跨 kind 列举（按 kind / 层 / 项目过滤，分页）。 */
  list(
    opts?: Omit<ListOptions, "kind"> & { kind?: string; tier?: Tier },
  ): Promise<StoreRow[]>;
  /** 跨 kind 检索（按 kind / 层 / 项目过滤）。 */
  search(
    opts: Omit<SearchOptions, "kind"> & { kind?: string; tier?: Tier },
  ): Promise<SearchHit[]>;
}

/** 已注册分类的统计（概要面；只报条数，不回显内容）。 */
export interface KindSummary {
  kind: string;
  table: string;
  writableTiers: readonly Tier[];
  rows: number;
}

export interface MemoryBundleSummary {
  ready: true;
  /** 已注册分类（含未写入、即未建表的分类，`rows` 为 0）。 */
  kinds: KindSummary[];
  /** 可解析的层落点（`created: false` = 库尚未创建，惰性建库）。 */
  tiers: Array<{ tier: Tier; path: string; created: boolean }>;
  /** 已打开库的条目合计。 */
  chunkCount: number;
  /** 已打开库的来源合计。 */
  sourceCount: number;
}

/** 核心工厂产物：可释放的 bundle（注册表、层集合、概要）。 */
export interface MemoryBundle {
  /** 分类注册表（进程内一份、各层库共用）。 */
  registry: KindRegistry;
  /** 分层库集合（惰性打开）。 */
  tiers: TierSet;
  /** 概要（同步：只读已打开的库与注册表）。 */
  summary(): MemoryBundleSummary;
  dispose(): void;
}

/** `createMemoryBundle` 入参（除配置外还需宿主侧解析到的会话目录面）。 */
export interface BundleOptions {
  config?: KnowledgeConfig;
  /** `session-paths` 服务（可选）：缺失时写会话层按明示例外报错。 */
  sessionPaths?: SessionPathsLike;
}

/** 最近一次成功创建的 bundle（apply 持有，供诊断与测试访问）。 */
let activeBundle: MemoryBundle | undefined;

/** 同步查询当前已建 bundle；未 apply 时返回 `undefined`。 */
export function getMemoryBundle(): MemoryBundle | undefined {
  return activeBundle;
}

/** `ctx.get("sessionPaths")` 探测：只认 `sessionDirFor` 一个方法（结构化类型，不 import 该包）。 */
export function readSessionPaths(
  host: BundleHost,
): SessionPathsLike | undefined {
  const service =
    typeof host.get === "function" ? host.get("sessionPaths") : undefined;
  if (service === null || typeof service !== "object") return undefined;
  const resolve = (service as { sessionDirFor?: unknown }).sessionDirFor;
  if (typeof resolve !== "function") return undefined;
  return {
    sessionDirFor: (sessionId: string): string => {
      try {
        const dir = (resolve as (id: string) => unknown).call(
          service,
          sessionId,
        );
        if (typeof dir !== "string" || dir.length === 0) {
          throw new Error(`会话「${sessionId}」的目录解析结果为空`);
        }
        return dir;
      } catch (error: unknown) {
        throw new Error(
          `memory-base 解析会话「${sessionId}」目录失败（session-paths 未就绪或会话取不到）：${String(error)}`,
        );
      }
    },
  };
}

/** 核心工厂：建注册表与层集合（**不打开任何库**，落点全部惰性解析）。 */
export function createMemoryBundle(options: BundleOptions = {}): MemoryBundle {
  const config = options.config ?? {};
  const registry = new KindRegistry();
  const tiers = TierSet.open({
    dshHome: config.dshHome ?? homedir(),
    projectRoot: config.projectRoot ?? process.cwd(),
    ...(options.sessionPaths === undefined
      ? {}
      : { sessionPaths: options.sessionPaths }),
    rules: compileRules(config.persistRules),
    registry,
    ...(config.journalMode === undefined
      ? {}
      : { journalMode: config.journalMode }),
  });

  const summary = (): MemoryBundleSummary => {
    const opened = tiers.all();
    const kinds: KindSummary[] = registry.list().map((entry) => ({
      kind: entry.kind,
      table: entry.table,
      writableTiers: entry.writableTiers,
      rows: opened.reduce(
        (total, store) =>
          total + store.kb.listRows({ kind: entry.kind, limit: 100 }).length,
        0,
      ),
    }));
    const tierList = TIERS.flatMap((tier) => {
      const path = tiers.pathFor(tier);
      return path === undefined
        ? []
        : [{ tier, path, created: tiers.opened(tier) !== undefined }];
    });
    let chunkCount = 0;
    let sourceCount = 0;
    for (const store of opened) {
      chunkCount += store.kb.countAll();
      const row = store.db
        .prepare("SELECT COUNT(*) AS n FROM sources")
        .get() as { n: number };
      sourceCount += Number(row.n);
    }
    return { ready: true, kinds, tiers: tierList, chunkCount, sourceCount };
  };

  return {
    registry,
    tiers,
    summary,
    dispose: () => tiers.close(),
  };
}

/** 全局面实现：八键，全部转发到 bundle / 层集合。 */
export function createGlobalService(
  bundle: MemoryBundle,
  config: KnowledgeConfig = {},
): MemoryGlobalService {
  const project = config.project ?? process.cwd();
  const host: ScopeHost = {
    async openWritable(
      tier: Tier,
      sessionId?: string,
    ): Promise<KnowledgeService> {
      const store = await bundle.tiers.openWritable(tier, sessionId);
      return store.kb;
    },
    opened: (tier: Tier, sessionId?: string): KnowledgeService | undefined =>
      bundle.tiers.opened(tier, sessionId)?.kb,
    defaultProject: () => project,
  };
  return {
    registerKind: (spec: KindSpec): MemoryScope =>
      createMemoryScope(host, bundle.registry.register(spec)),
    checkPrivacy: (text: string): string | null =>
      matchDenyPattern(compileRules(config.persistRules), text),
    getSummary: () => bundle.summary(),
    whenReady: () => Promise.resolve(bundle),
    usage: () => bundle.tiers.usage(),
    migrate: (opts) =>
      migrate({
        dbPath:
          config.legacyDbPath ??
          join(config.dshHome ?? homedir(), "memory-base", "memory.db"),
        from: opts.from,
        mode: opts.mode,
      }),
    list: async (opts) => {
      const limit = Math.max(
        1,
        Math.min(opts?.limit ?? config.listLimit ?? 20, 100),
      );
      return bundle.tiers.list({
        ...(opts?.kind === undefined ? {} : { kind: opts.kind }),
        ...(opts?.tier === undefined ? {} : { tier: opts.tier }),
        ...(opts?.project === undefined ? {} : { project: opts.project }),
        limit,
        offset: Math.max(0, opts?.offset ?? 0),
      });
    },
    search: async (opts) =>
      bundle.tiers.search({
        query: opts.query,
        ...(opts.kind === undefined ? {} : { kind: opts.kind }),
        ...(opts.tier === undefined ? {} : { tier: opts.tier }),
        ...(opts.project === undefined ? {} : { project: opts.project }),
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.fuzzy === undefined ? {} : { fuzzy: opts.fuzzy }),
      }),
  };
}

/** 暴露 `memory` 服务面（`ctx.provide` 缺失时静默跳过）。 */
function provideMemory(ctx: BundleHost, memory: MemoryGlobalService): void {
  if (typeof ctx.provide !== "function") return;
  try {
    ctx.provide("memory", memory);
  } catch (error: unknown) {
    ctx
      .logger?.(name)
      .info(`memory-base 服务面暴露失败（忽略）：${String(error)}`);
  }
}

/** 注册 `memory_query`（只读）；`ctx.tools` 缺失时只记日志，不影响写入面。 */
function registerTools(ctx: BundleHost, memory: MemoryGlobalService): void {
  if (ctx.tools === undefined) {
    ctx
      .logger?.(name)
      .info("memory-base 未注册 memory_query（宿主未暴露 tools 服务）");
    return;
  }
  const executor: MemoryQueryExecutor = {
    list: (opts) => memory.list(opts),
    search: (opts) => memory.search(opts),
  };
  try {
    ctx.tools.register(memoryQueryTool(executor));
  } catch (error: unknown) {
    ctx
      .logger?.(name)
      .info(`memory-base 注册 memory_query 失败（忽略）：${String(error)}`);
  }
}

/**
 * DSH 宿主按 bundle 契约调用（结构化 ctx）。同步完成：建 bundle → 暴露 `memory` 面 →
 * 注册 `memory_query`；不打开任何库（首次写入才建），因此没有异步就绪窗口。
 */
export function apply(ctx: BundleHost, config: KnowledgeConfig = {}): void {
  try {
    const sessionPaths = readSessionPaths(ctx);
    const bundle = createMemoryBundle({
      config,
      ...(sessionPaths === undefined ? {} : { sessionPaths }),
    });
    activeBundle = bundle;
    const memory = createGlobalService(bundle, config);
    provideMemory(ctx, memory);
    registerTools(ctx, memory);
    const userPath = bundle.tiers.pathFor("user");
    ctx
      .logger?.(name)
      .info(
        `memory-base 已就绪（分层库惰性创建；U=${userPath ?? "-"}；session-paths=${sessionPaths === undefined ? "未挂载" : "已挂载"}）`,
      );
  } catch (error: unknown) {
    ctx.logger?.(name).info(`memory-base 启动失败：${String(error)}`);
  }
}
