/**
 * output-compress：DSH 进程内集成大输出压缩插件（bundle 入口）。
 *
 * 职责边界（见 DESIGN.md §3.1 / §12 #7）：
 *  - 派生摘要 + 切片索引写入**自持** `digest.db`（每会话一个文件，'DIGE' 指纹，本包自管）；
 *  - 原始字节由宿主 retention/spill 保留落盘，不入知识库全文、不进模型上下文；
 *  - `is_error` 行经 memory-base 的**作用域句柄** `put` 写入（注册 `digest` 分类，
 *    `writableTiers: ["session"]`；可选依赖，缺失时一次性告警、行保持未推）；
 *  - 与 memory-base 的共享面 = 隐私底线常量（同源复制 + 指纹封印对拍）+ 句柄写入面。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：
 * Config 为类型别名（无运行时 schema，宿主原样透传）。
 */
import { join } from "node:path";
import {
  OutputCompressHooks,
  type MemoryScopeLike,
  type MemoryTier,
  type SessionEventLike,
  type SessionPathsLike,
} from "./hooks.ts";
import { resolveSessionDigestPath } from "./digest-db.ts";
import type { CodeRuntimeLike, SandboxRunner } from "./sandbox.ts";
import {
  CodeRuntimeSandbox,
  RuntimeWithFallback,
  VmSandbox,
} from "./sandbox.ts";

/** bundle 名（cordis 注册键，与 cordis.patch.yml 的 id 对应）。 */
export const name = "output-compress";

/**
 * 摘要分类（memory-base 的 `kind`）：本包 apply 时经 `registerKind` 注册并拿写入句柄；
 * 行归属由 `kind: "digest"` 表达（不依赖任何语义列）。
 */
export const DIGEST_KIND = "digest";

/** bundle 配置（cordis.patch.yml 的 config 映射，字段均可选）。 */
export interface OutputCompressConfig {
  /**
   * digest.db 落点的**显式覆盖**（决策项 9）：配了就优先用它，且仍要求目录已存在
   * （existsSync 判据、**不 mkdir**；缺失 = 解析失败：告警 + 跳过写入，不静默换路径）。
   * 缺省 undefined = 按会话经 `sessionPaths.sessionDirFor(sessionId)` 推导。
   */
  sessionDir?: string;
  /** 无 spill 通知时触发压缩的最小文本字节数（UTF-8），默认 16384（16KB）。 */
  minBytes?: number;
  /** 从 spill 文件读取完整输出的字节上限，默认 524288（512KB）。 */
  maxSourceBytes?: number;
}

export type Config = OutputCompressConfig;

/** bundle 生命周期句柄。 */
export interface OutputCompressBundle {
  dispose(): void;
  /** 巩固重推（能力缺失导致未推的 digests）+ 各已打开会话库的容量自查。 */
  promotePending(): Promise<{ pushed: number; pruned: number }>;
  /** 待重推行数（`push_state = 'none'` 且命中重推判据；观测用）。 */
  pendingPushCount(): number;
}

/** 默认阈值（与 TASK 契约一致：16KB / 512KB）。 */
export const DEFAULT_MIN_BYTES = 16384;
export const DEFAULT_MAX_SOURCE_BYTES = 524_288;

/** memory 服务面（`registerKind` + 隐私查询；只读全局面，写入经返回的句柄）。 */
export interface MemoryServiceLike {
  registerKind?(spec: {
    kind: string;
    writableTiers?: readonly MemoryTier[];
  }): unknown;
  checkPrivacy?(text: string): string | null;
}

/** reflect 层可选读取的服务值（沙箱 / memory / session-paths 三类）。 */
export type ServiceValue =
  CodeRuntimeLike | MemoryServiceLike | SessionPathsLike | undefined;

/** 宿主 ctx 的最小结构化视图（事件面 + 可选沙箱 / memory / session-paths / logger / reflect）。 */
export interface BundleHost {
  on(
    event: "session/event",
    callback: (session: { id: string }, event: SessionEventLike) => void,
  ): void | (() => void);
  /** 宿主沙箱服务（仅测试宿主直接携带；真实 cordis 代理走 reflect）。 */
  ptcRuntime?: CodeRuntimeLike;
  /** memory 服务（仅测试宿主直接携带；真实 cordis 代理走 reflect）。 */
  memory?: MemoryServiceLike;
  /** session-paths 服务（仅测试宿主直接携带；真实 cordis 代理走 reflect）。 */
  sessionPaths?: SessionPathsLike;
  logger?(ns: string): { info(message: string): void };
  reflect?: { get?(name: string, strict?: boolean): ServiceValue };
}

interface RuntimeRef {
  readonly name: "ptcRuntime";
  readonly service: CodeRuntimeLike;
}

/** 解析宿主沙箱服务（可选依赖，ptcRuntime 单一形态；详见旧实现注释）。 */
function resolveSandboxRuntime(host: BundleHost): RuntimeRef | undefined {
  if (host.reflect !== undefined) {
    const ptc = host.reflect.get?.("ptcRuntime", false);
    if (ptc !== undefined && typeof ptc === "object" && "run" in ptc) {
      return { name: "ptcRuntime", service: ptc as CodeRuntimeLike };
    }
    return undefined;
  }
  return host.ptcRuntime === undefined
    ? undefined
    : { name: "ptcRuntime", service: host.ptcRuntime };
}

/** 解析 memory 服务（registerKind；reflect 优先，测试宿主回落属性）。 */
function resolveMemoryService(host: BundleHost): MemoryServiceLike | undefined {
  if (host.reflect !== undefined) {
    const memory = host.reflect.get?.("memory", false);
    if (memory !== undefined && typeof memory === "object") {
      return memory as MemoryServiceLike;
    }
    return undefined;
  }
  return host.memory;
}

/** 解析 session-paths 服务（可选依赖；缺失 = digest 落点不可推导）。 */
function resolveSessionPaths(host: BundleHost): SessionPathsLike | undefined {
  if (host.reflect !== undefined) {
    const service = host.reflect.get?.("sessionPaths", false);
    if (
      service !== undefined &&
      typeof service === "object" &&
      "sessionDirFor" in service
    ) {
      return service as SessionPathsLike;
    }
    return undefined;
  }
  return host.sessionPaths;
}

/** 注册 `digest` 分类并取写入句柄（缺失 / 抛错都返回原因，不向宿主抛错）。 */
function resolveMemoryScope(host: BundleHost): {
  scope?: MemoryScopeLike;
  error?: string;
} {
  const memory = resolveMemoryService(host);
  if (memory === undefined) return { error: "memory 服务未挂载" };
  if (typeof memory.registerKind !== "function") {
    return { error: "memory 服务未提供 registerKind" };
  }
  try {
    const scope = memory.registerKind({
      kind: DIGEST_KIND,
      writableTiers: ["session"],
    });
    if (scope === undefined || scope === null || typeof scope !== "object") {
      return { error: "registerKind 未返回写入句柄" };
    }
    return { scope: scope as MemoryScopeLike };
  } catch (error: unknown) {
    return { error: String(error) };
  }
}

/**
 * 组装 output-compress bundle：解析 digest 落点（显式覆盖 / 按会话推导）、
 * 选择沙箱执行器、注册 `digest` 分类拿写入句柄、挂事件钩子、启动后跑一轮
 * 巩固重推（promotePending）。
 */
export async function createOutputCompressBundle(
  host: BundleHost,
  config: OutputCompressConfig = {},
): Promise<OutputCompressBundle> {
  const log = (message: string) => host.logger?.(name).info(message);
  // 落点：显式覆盖才在此判定存在性（D60-b）；缺省 undefined = 按会话推导。
  const overrideDir =
    config.sessionDir === undefined
      ? undefined
      : resolveSessionDigestPath(config.sessionDir);
  const digestDbPath =
    overrideDir === undefined
      ? undefined
      : overrideDir === null
        ? null
        : join(overrideDir, "digest.db");
  const runtime = resolveSandboxRuntime(host);
  const sandbox: SandboxRunner =
    runtime === undefined
      ? new VmSandbox()
      : new RuntimeWithFallback(
          new CodeRuntimeSandbox(runtime.service),
          new VmSandbox(),
          (message: string) => log(`output-compress 回落 node:vm：${message}`),
        );
  // 句柄惰性解析（memory-base 可能晚于本包挂载）；缺面只提示一次。
  let scopeLogged = false;
  const resolveScope = (): MemoryScopeLike | undefined => {
    const resolved = resolveMemoryScope(host);
    if (resolved.scope === undefined && !scopeLogged) {
      scopeLogged = true;
      log(
        `output-compress: digest 分类句柄不可用（${resolved.error ?? "memory 未挂载"}）—— digest 只留本地 digest.db，is_error 摘要不入知识库`,
      );
    }
    return resolved.scope;
  };
  const scope = resolveScope();
  const sessionPaths = resolveSessionPaths(host);
  if (sessionPaths === undefined) {
    log(
      "output-compress: session-paths 服务未挂载 —— digest 落点需经它按会话推导（可用 sessionDir 显式覆盖）",
    );
  }
  const hooks = new OutputCompressHooks({
    minBytes: config.minBytes ?? DEFAULT_MIN_BYTES,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    digestDbPath,
    ...(scope === undefined ? {} : { scope }),
    getScope: () => resolveScope(),
    ...(sessionPaths === undefined ? {} : { sessionPaths }),
    sandbox,
    logger: { info: (message) => log(message) },
  });
  const detach = hooks.attach(host);
  log(
    `output-compress ready (digest=${
      digestDbPath === undefined
        ? "按会话推导（session-paths）"
        : (digestDbPath ?? "unavailable（配置的会话目录缺失，跳过写入）")
    }, memory=${scope === undefined ? "未挂载" : "句柄就绪"}, sandbox=${
      runtime?.name ?? "vm"
    })`,
  );
  // 启动后一轮巩固重推（设计 §6「重推在属主巩固时」；属主自管）。
  void hooks.promotePending().catch((error: unknown) => {
    log(`output-compress 巩固重推失败（忽略）：${String(error)}`);
  });
  return {
    dispose: () => {
      detach();
      hooks.closeDatabases();
    },
    promotePending: () => hooks.promotePending(),
    pendingPushCount: () => hooks.pendingPushCount(),
  };
}

/** DSH bundle 挂载入口（cordis apply 契约；启动失败不抛给宿主）。 */
export function apply(
  ctx: BundleHost,
  config: OutputCompressConfig = {},
): void {
  void createOutputCompressBundle(ctx, config).catch((error: unknown) => {
    ctx
      .logger?.(name)
      .info(`output-compress 启动失败，放弃挂载: ${String(error)}`);
  });
}
