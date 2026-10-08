/**
 * output-compress：DSH 进程内集成大输出压缩插件（bundle 入口）。
 *
 * 职责边界（见 DESIGN.md §3.1 / §12 #7）：
 *  - 派生摘要 + 切片索引写入**自持** `digest.db`（会话目录内，'DIGE' 指纹，本包自管）；
 *  - 原始字节由宿主 retention/spill 保留落盘，不入知识库全文、不进模型上下文；
 *  - `is_error` 行经 promote 服务面推 I→S 候选（ctx.reflect.get('memory')，可选依赖）；
 *  - 与 memory-base 的共享面 = 隐私底线常量（同源复制 + 指纹封印对拍）+ promote 服务面。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：
 * Config 为类型别名（无运行时 schema，宿主原样透传）。
 */
import { join } from "node:path";
import {
  OutputCompressHooks,
  type PromoteServiceLike,
  type SessionEventLike,
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
 * I→S 候选的注册分类（本包 apply 时经 memory 服务面 registerKind 注册；
 * 设计 §6 L181「建议分类由注册方给出」——I 层产物统一落本分类）。
 */
export const DIGEST_KIND = "digest";

/** bundle 配置（cordis.patch.yml 的 config 映射，字段均可选）。 */
export interface OutputCompressConfig {
  /**
   * 会话目录（digest.db 落点 `<sessionDir>/digest.db`；决策 D60-b：目录由宿主创建，
   * **existsSync 判据且不 mkdir**——缺失 = 解析失败：告警 + 跳过写入，不静默换路径）。
   * 缺省 undefined = 落点不可得（管线全部 skipped.sessionDirMissing）。
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
  /** 巩固重推（is_error / 被回查引用过且未推成功的 digests）+ 候选容量自查。 */
  promotePending(): Promise<{ pushed: number; pruned: number }>;
}

/** 默认阈值（与 TASK 契约一致：16KB / 512KB）。 */
export const DEFAULT_MIN_BYTES = 16384;
export const DEFAULT_MAX_SOURCE_BYTES = 524_288;

/** memory 服务面（promote / registerKind）的宽松子集（可选依赖）。 */
export interface MemoryPromoteLike {
  promote?(items: readonly unknown[]): Promise<unknown[]>;
  registerKind?(spec: { kind: string }): Promise<unknown> | unknown;
}

/** reflect 层可选读取的服务值（沙箱 / memory 两类）。 */
export type ServiceValue = CodeRuntimeLike | MemoryPromoteLike | undefined;

/** 宿主 ctx 的最小结构化视图（BundleHost = 事件面 + 可选沙箱 / memory / logger / reflect）。 */
export interface BundleHost {
  on(
    event: "session/event",
    callback: (session: { id: string }, event: SessionEventLike) => void,
  ): void | (() => void);
  /** 宿主沙箱服务（仅测试宿主直接携带；真实 cordis 代理走 reflect）。 */
  ptcRuntime?: CodeRuntimeLike;
  /** memory 服务（仅测试宿主直接携带；真实 cordis 代理走 reflect）。 */
  memory?: MemoryPromoteLike;
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

/** 解析 memory 服务（promote / registerKind；reflect 优先，测试宿主回落属性）。 */
function resolveMemoryService(host: BundleHost): MemoryPromoteLike | undefined {
  if (host.reflect !== undefined) {
    const memory = host.reflect.get?.("memory", false);
    if (memory !== undefined && typeof memory === "object") {
      return memory as MemoryPromoteLike;
    }
    return undefined;
  }
  return host.memory;
}

/**
 * 组装 output-compress bundle：解析 digest 落点、选择沙箱执行器、注册 I→S 分类、
 * 挂事件钩子、启动后跑一轮巩固重推（promotePending）。
 */
export async function createOutputCompressBundle(
  host: BundleHost,
  config: OutputCompressConfig = {},
): Promise<OutputCompressBundle> {
  const log = (message: string) => host.logger?.(name).info(message);
  // 落点判据（D60-b）：会话目录必须已存在；缺失 = 路径 null（管线全部 skipped）。
  const sessionDir = resolveSessionDigestPath(config.sessionDir);
  const digestDbPath =
    sessionDir === null ? null : join(sessionDir, "digest.db");
  const runtime = resolveSandboxRuntime(host);
  const sandbox: SandboxRunner =
    runtime === undefined
      ? new VmSandbox()
      : new RuntimeWithFallback(
          new CodeRuntimeSandbox(runtime.service),
          new VmSandbox(),
          (message: string) => log(`output-compress 回落 node:vm：${message}`),
        );
  const memory = resolveMemoryService(host);
  // I→S 分类注册（设计 §6 L181；失败只告警——push 时会以 kind-unregistered 回报）。
  try {
    const registered = memory?.registerKind?.({ kind: DIGEST_KIND });
    if (registered instanceof Promise) await registered;
  } catch (error: unknown) {
    log(`output-compress: registerKind 失败（忽略）：${String(error)}`);
  }
  const hooks = new OutputCompressHooks({
    minBytes: config.minBytes ?? DEFAULT_MIN_BYTES,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    digestDbPath,
    ...(memory === undefined ? {} : { promote: memory as PromoteServiceLike }),
    sandbox,
    logger: { info: (message) => log(message) },
  });
  const detach = hooks.attach(host);
  log(
    `output-compress ready (digest=${
      digestDbPath ?? "unavailable（会话目录缺失，跳过写入）"
    }, sandbox=${runtime?.name ?? "vm"})`,
  );
  // 启动后一轮巩固重推（设计 §6「重推在属主巩固时」；属主自管）。
  void hooks.promotePending().catch((error: unknown) => {
    log(`output-compress 巩固重推失败（忽略）：${String(error)}`);
  });
  return {
    dispose: () => {
      detach();
    },
    promotePending: () => hooks.promotePending(),
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
