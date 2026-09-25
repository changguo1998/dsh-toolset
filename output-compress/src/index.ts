/**
 * output-compress：DSH 进程内集成大输出压缩入库插件（bundle 入口）。
 *
 * 职责边界（见 DESIGN.md）：
 *  - 只负责「派生摘要 + 切片索引」并写入 knowledge-base 共享库；
 *  - 原始字节由宿主 retention/spill 保留落盘，不进知识库全文、不进模型上下文；
 *  - 不做 npm 级 knowledge-base 依赖，共享面 = 同一 SQLite 库文件。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / Config / apply(ctx, config)（无 inject / provide，沙箱服务经 ctx.reflect 可选读取：
 * 0.1.7 起 `ptcRuntime`，≤0.1.5 为 `codeRuntime`），
 * Config 以类型别名给出（无运行时 schema，宿主不校验，配置原样透传给 apply；缺省/非法值
 * 沿用本包既有语义，不新增校验）。
 */
import type { HookHost } from "./hooks.ts";
import { OutputCompressHooks } from "./hooks.ts";
import { resolveDbPath, SharedKbWriter } from "./kb-write.ts";
import type { CodeRuntimeLike, SandboxRunner } from "./sandbox.ts";
import {
  CodeRuntimeSandbox,
  RuntimeWithFallback,
  VmSandbox,
} from "./sandbox.ts";

/** bundle 名（cordis 注册键，与 cordis.patch.yml 的 id 对应）。 */
export const name = "output-compress";

/** bundle 配置（cordis.patch.yml 的 config 映射，字段均可选）。 */
export interface OutputCompressConfig {
  /** 共享库路径；缺省走 resolveDbPath 的 env/默认链。 */
  dbPath?: string;
  /** 无 spill 通知时触发压缩的最小文本字节数（UTF-8），默认 16384（16KB）。 */
  minBytes?: number;
  /** 从 spill 文件读取完整输出的字节上限，默认 524288（512KB）。 */
  maxSourceBytes?: number;
  /** 库未挂载重试的退避延迟（ms）；缺省 [1000, 2500, 5000, 10000]。 */
  kbRetryDelays?: number[];
  /** 入库 project；字符串或按调用上下文动态获取。 */
  project?: string | (() => string);
}

/**
 * Config 契约别名（DSH bundle §0 的 `Config`）：仅类型级导出，不新增运行时 schema——
 * cordis `resolveConfig()` 只在本导出带 `'~standard'` 校验接口时才校验配置，无 schema 即
 * 原样透传，故不改变本包既有的缺省回退/启动失败只告警语义（避免 fail-closed 改变行为）。
 */
export type Config = OutputCompressConfig;

/** bundle 生命周期句柄。 */
export interface OutputCompressBundle {
  dispose(): void;
}

/** 默认阈值（与 TASK 契约一致：16KB / 512KB）。 */
export const DEFAULT_MIN_BYTES = 16384;
export const DEFAULT_MAX_SOURCE_BYTES = 524_288;

/** reflect 层可选读取的服务值类型（本插件仅读沙箱服务，未挂载时为 undefined）。 */
export type ServiceValue = CodeRuntimeLike | undefined;

/** 宿主 ctx 的最小结构化视图（BundleHost = HookHost + 可选沙箱服务/logger/reflect）。 */
export interface BundleHost extends HookHost {
  /**
   * 宿主沙箱服务 0.1.7 版名（仅测试宿主直接携带；真实 cordis 代理上直接读该属性会抛错，
   * 生产路径经 reflect 可选读取，见 resolveSandboxRuntime）。
   */
  ptcRuntime?: CodeRuntimeLike;
  /**
   * 宿主沙箱服务 ≤0.1.5 版名（同上，测试宿主直接携带用）。
   */
  codeRuntime?: CodeRuntimeLike;
  /** 宿主日志服务。 */
  logger?(ns: string): { info(message: string): void };
  /**
   * cordis 反射层：`reflect.get(name, strict)` 可在不声明 inject 的前提下读服务，
   * 服务未挂载时返回 undefined（可选依赖语义）。
   */
  reflect?: { get?(name: string, strict?: boolean): ServiceValue };
}

/** 命中的沙箱服务引用（name 用于启动日志，service 用于执行）。 */
interface RuntimeRef {
  readonly name: "ptcRuntime" | "codeRuntime";
  readonly service: CodeRuntimeLike;
}

/**
 * 解析宿主沙箱服务（可选依赖），服务名随宿主版本变化：
 * 0.1.7 起为 `ptcRuntime`（PTC 运行时），≤0.1.5 为 `codeRuntime`，按序探测取首个命中。
 * 真实宿主 ctx 是 cordis 代理，直接读未 inject 的服务属性会抛
 * `cannot get property "x" without inject`，因此生产路径必须走
 * `ctx.reflect.get(<name>, false)`（未挂载返回 undefined）。
 * 普通对象测试宿主没有 reflect 层，回退直接读同名属性（两种语义不混用）。
 */
function resolveSandboxRuntime(host: BundleHost): RuntimeRef | undefined {
  if (host.reflect !== undefined) {
    const ptc = host.reflect.get?.("ptcRuntime", false);
    if (ptc !== undefined) return { name: "ptcRuntime", service: ptc };
    const legacy = host.reflect.get?.("codeRuntime", false);
    return legacy === undefined
      ? undefined
      : { name: "codeRuntime", service: legacy };
  }
  if (host.ptcRuntime !== undefined) {
    return { name: "ptcRuntime", service: host.ptcRuntime };
  }
  return host.codeRuntime === undefined
    ? undefined
    : { name: "codeRuntime", service: host.codeRuntime };
}

/**
 * 组装 output-compress bundle：解析 dbPath、选择沙箱执行器、挂事件钩子。
 * 独立导出以便测试与程序化挂载（不经过 apply 的 fire-and-forget）。
 */
export async function createOutputCompressBundle(
  host: BundleHost,
  config: OutputCompressConfig = {},
): Promise<OutputCompressBundle> {
  const log = (message: string) => host.logger?.(name).info(message);
  const dbPath = resolveDbPath(config.dbPath);
  const writer = new SharedKbWriter(dbPath, (message) => log(message));
  // 沙箱选择：宿主沙箱（0.1.7 的 ptcRuntime / ≤0.1.5 的 codeRuntime）可用时走宿主沙箱（默认），
  // 服务缺失、或运行期「不可用」（resolve/run 抛错）时回落 node:vm
  const runtime = resolveSandboxRuntime(host);
  const sandbox: SandboxRunner =
    runtime === undefined
      ? new VmSandbox()
      : new RuntimeWithFallback(
          new CodeRuntimeSandbox(runtime.service),
          new VmSandbox(),
          (message) => log(`output-compress 回落 node:vm：${message}`),
        );
  const hooks = new OutputCompressHooks({
    minBytes: config.minBytes ?? DEFAULT_MIN_BYTES,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    project: config.project ?? "default",
    writer,
    sandbox,
    logger: { info: (message) => log(message) },
    kbRetryDelays: config.kbRetryDelays,
  });
  const detach = hooks.attach(host);
  log(`output-compress ready (db=${dbPath}, sandbox=${runtime?.name ?? "vm"})`);
  return {
    dispose: () => {
      detach();
      writer.close();
    },
  };
}

/**
 * DSH bundle 挂载入口（cordis apply 契约，对齐 knowledge-base 的 fire-and-forget 语义）。
 * 启动失败不抛给宿主：记录告警后放弃挂载（不阻塞会话启动）。
 */
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
