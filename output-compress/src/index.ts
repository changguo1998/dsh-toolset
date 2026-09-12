/**
 * output-compress：DSH 进程内集成大输出压缩入库插件（bundle 入口）。
 *
 * 职责边界（见 DESIGN.md）：
 *  - 只负责「派生摘要 + 切片索引」并写入 knowledge-base 共享库；
 *  - 原始字节由宿主 retention/spill 保留落盘，不进知识库全文、不进模型上下文；
 *  - 不做 npm 级 knowledge-base 依赖，共享面 = 同一 SQLite 库文件。
 *
 * DSH bundle 契约（对齐 knowledge-base）：导出 name / Config / apply(ctx, config)。
 */
import type { HookHost } from "./hooks.ts";
import { OutputCompressHooks } from "./hooks.ts";
import { resolveDbPath, SharedKbWriter } from "./kb-write.ts";
import type { CodeRuntimeLike, SandboxRunner } from "./sandbox.ts";
import { CodeRuntimeSandbox, VmSandbox } from "./sandbox.ts";

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

/** bundle 生命周期句柄。 */
export interface OutputCompressBundle {
  dispose(): void;
}

/** 默认阈值（与 TASK 契约一致：16KB / 512KB）。 */
export const DEFAULT_MIN_BYTES = 16384;
export const DEFAULT_MAX_SOURCE_BYTES = 524_288;

/** reflect 层可选读取的服务值类型（本插件仅读 codeRuntime，未挂载时为 undefined）。 */
export type ServiceValue = CodeRuntimeLike | undefined;

/** 宿主 ctx 的最小结构化视图（BundleHost = HookHost + 可选 codeRuntime/logger/reflect）。 */
export interface BundleHost extends HookHost {
  /**
   * 宿主 code-runtime 服务（仅测试宿主直接携带；真实 cordis 代理上直接读该属性会抛错，
   * 生产路径经 reflect 可选读取，见 resolveCodeRuntime）。
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

/**
 * 解析宿主 code-runtime（可选依赖）：
 * 真实宿主 ctx 是 cordis 代理，直接读未 inject 的服务属性会抛
 * `cannot get property "codeRuntime" without inject`，因此生产路径必须走
 * `ctx.reflect.get('codeRuntime', false)`（未挂载返回 undefined）。
 * 普通对象测试宿主没有 reflect 层，回退直接读 `codeRuntime` 属性。
 */
function resolveCodeRuntime(host: BundleHost): CodeRuntimeLike | undefined {
  // 真实 cordis 宿主：有 reflect 层，只能经可选读取入口取服务（未挂载 → undefined）。
  if (host.reflect !== undefined)
    return host.reflect.get?.("codeRuntime", false);
  // 普通对象宿主（测试替身）：无 reflect 层，直接读属性；两种语义不混用。
  return host.codeRuntime;
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
  // 沙箱选择：宿主 code-runtime 可用走 worker 沙箱（默认），否则 node:vm 回落
  const runtime = resolveCodeRuntime(host);
  const sandbox: SandboxRunner =
    runtime !== undefined ? new CodeRuntimeSandbox(runtime) : new VmSandbox();
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
  log(
    `output-compress ready (db=${dbPath}, sandbox=${
      runtime !== undefined ? "code-runtime" : "vm"
    })`,
  );
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
