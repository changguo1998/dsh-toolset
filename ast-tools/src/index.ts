/**
 * ast-tools 插件入口（DSH bundle 集成面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / inject / apply，Config 以类型别名给出（无运行时 schema，宿主不校验，
 * 配置原样透传给 apply；缺省/非法值沿用本包既有语义，不新增校验）。
 * cordis 加载器识别 named apply 导出；与 memory-base/TUI 同款挂载形态。
 *
 * 四个操作 search/replace/outline/rules 均委托系统 ast-grep CLI 子进程
 * （选型依据见 README「二进制选型」）；二进制缺失时 apply 走降级：
 * 记录含安装路径的日志，并注册**降级版工具**——每次调用返回含 `INSTALL_GUIDANCE` 的错误值，
 * 不假装成功（fail-closed），但模型侧仍可发现该能力并读到安装指引（口径对齐 code-map）。
 * 模型侧工具面：`ast_query`（search/outline/rules）+ `ast_replace`（默认 dry-run），见 ast-tools/src/tools.ts。
 *
 * 文件读写只经 `AstFileIo`（`ast-tools/src/io.ts`）：插件侧由 `apply` 注入 `ctx.fs` 实现（`ast-tools/src/ctx-fs-io.ts`），
 * 库面 / 示例 / 单测缺省用 `node:fs` 实现。`ctx.fs` 缺失时不回落 `node:fs`, 工具调用返回可行动错误。
 */

import {
  AstGrepMissingError,
  DEFAULT_TIMEOUT_MS,
  ensureAstGrepBin,
} from "./binary.ts";
import type {
  AstMatch,
  AstOptions,
  AstRuleHit,
  OutlineFile,
  OutlineParams,
  ReplaceParams,
  ReplaceResult,
  RunRulesParams,
  SearchParams,
  ToolExecLike,
} from "./types.ts";
import type { AstFileIo } from "./io.ts";
import type { AstFsHostLike } from "./ctx-fs-io.ts";
import { ctxAstFileIo } from "./ctx-fs-io.ts";
import { searchAst } from "./search.ts";
import { replaceAst } from "./replace.ts";
import { outlineFile } from "./outline.ts";
import { runRules } from "./rules.ts";
import { createDeadline, resolveClock } from "@dsh-toolset/clock-base";
import type { Deadline } from "@dsh-toolset/clock-base";
import { toToolDefs, unavailableOps } from "./tools.ts";

export {
  AstGrepError,
  AstGrepJsonError,
  AstGrepMissingError,
  AstGrepProcessError,
  DEFAULT_TIMEOUT_MS,
  INSTALL_GUIDANCE,
  ensureAstGrepBin,
  findAstGrepBin,
  runCli,
  runCliJson,
} from "./binary.ts";
export type { CliResult } from "./binary.ts";
export {
  RENDER_LIMIT,
  astQueryTool,
  astReplaceTool,
  renderMatches,
  renderOutlineFiles,
  renderReplace,
  renderRuleHits,
  toToolDefs,
  unavailableOps,
} from "./tools.ts";
export type { AstOperations } from "./tools.ts";
export {
  AstFileError,
  astFileErrorText,
  isAstFileErrorCode,
  nodeAstFileIo,
} from "./io.ts";
export type {
  AstFileErrorCode,
  AstFileInfo,
  AstFileIo,
  AstFileTarget,
  AstResolveOptions,
  AstWriteIntent,
  AstWriteOutcome,
  NodeAstFileIoOptions,
} from "./io.ts";
export { ctxAstFileIo } from "./ctx-fs-io.ts";
export type {
  AstFsHostLike,
  AstFsServiceLike,
  AstObservation,
  AstSandboxPolicyServiceLike,
  AstWorkingDirectoryLike,
} from "./ctx-fs-io.ts";
export { normalizeLanguage } from "./langs.ts";
export { searchAst } from "./search.ts";
export { replaceAst } from "./replace.ts";
export { outlineFile } from "./outline.ts";
export { runRules } from "./rules.ts";
export type {
  AstByteRange,
  AstMetaVariable,
  AstMetaVariables,
  AstMatch,
  AstOptions,
  AstPos,
  AstRange,
  AstRuleHit,
  AstStrictness,
  OutlineFile,
  OutlineItems,
  OutlineParams,
  OutlineSymbol,
  ReplaceParams,
  ReplaceResult,
  RuleSource,
  RunRulesParams,
  SearchParams,
  ToolExecLike,
} from "./types.ts";

/** 插件名（bundle 标识，cordis.patch.yml insert 条目同名）。 */
export const name = "ast-tools";

/** 注入面：tools 注册工具; fs 是 `ast_replace` 的文件读写面（缺它时工具调用返回可行动错误）。 */
export const inject = ["tools", "fs"];

/**
 * 结构化宿主 ctx（最小 DSH cordis 形态）：可选 logger、工具注册面、服务读取口,
 * 另含 `AstFsHostLike`（`fs` / `workingDirectory` / `sandboxPolicy` / `waterfall` / `emit`）。
 */
export interface BundleHost extends AstFsHostLike {
  logger?(ns: string): {
    info(message: string): void;
    warn?(message: string): void;
  };
  tools?: { register(def: unknown): unknown };
  /** 宿主服务读取口（`ctx.get`；`clock` 等可选服务经受保护读取）。 */
  get?(name: string): unknown;
  /** 副作用登记（`clock.scope(ctx)` 的排期随本插件 fiber 卸载撤销）。 */
  effect?(fn: () => () => void): unknown;
}

/** 插件配置（Config 契约名）。 */
export interface AstToolsConfig {
  /** 显式指定 ast-grep 二进制路径（探测顺序中优先级最高）。 */
  bin?: string;
  /** 子进程超时（毫秒），缺省 30s。 */
  timeoutMs?: number;
}

/**
 * Config 契约别名（DSH bundle §0 的 `Config`）：仅类型级导出，不新增运行时 schema——
 * cordis `resolveConfig()` 只在本导出带 `'~standard'` 校验接口时才校验配置，无 schema 即
 * 原样透传，故不改变本包既有的缺省回退/二进制缺失降级告警语义（避免 fail-closed 改变行为）。
 */
export type Config = AstToolsConfig;

/** 可复用 bundle 实例（核心工厂产物，也是宿主侧可消费的服务形态）。 */
export interface AstToolsBundle {
  /** 已解析的 ast-grep 二进制路径。 */
  readonly bin: string;
  /** AST 模式搜索。 */
  search(params: SearchParams): Promise<AstMatch[]>;
  /** 结构化替换（可选写回；`exec` 提供相对路径基准、取消信号与围栏会话）。 */
  replace(params: ReplaceParams, exec?: ToolExecLike): Promise<ReplaceResult>;
  /** 文件大纲。 */
  outline(params: OutlineParams): Promise<OutlineFile[]>;
  /** 规则执行（YAML 规则文件或内联文本）。 */
  rules(params: RunRulesParams): Promise<AstRuleHit[]>;
  /** 释放（子进程一次性、无持久资源，保留以对齐契约）。 */
  dispose(): void;
}

/**
 * 核心工厂：探测二进制并绑定通用选项，返回 bundle 实例。
 * 二进制缺失时抛 AstGrepMissingError（报错含安装路径）。
 * @param config 插件配置（二进制路径与超时）。
 * @param deadline 子进程超时排期（`apply` 装配期注入统一面）。
 * @param ioFor 按调用上下文构造文件读写面; 缺省不给——`replace` 用 `nodeAstFileIo()`
 *   （库面 / 示例 / 单测口径）。插件侧由 `apply` 传入 `ctx.fs` 实现, 不回落 `node:fs`。
 */
export function createAstToolsBundle(
  config: AstToolsConfig = {},
  deadline?: Deadline,
  ioFor?: (exec?: ToolExecLike) => AstFileIo,
): AstToolsBundle {
  const bin = ensureAstGrepBin(config.bin);
  const base: AstOptions = {
    bin,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(deadline === undefined ? {} : { deadline }),
  };
  return {
    bin,
    search: (params) => searchAst(params, base),
    replace: (params, exec) =>
      replaceAst(params, base, ioFor === undefined ? undefined : ioFor(exec)),
    outline: (params) => outlineFile(params, base),
    rules: (params) => runRules(params, base),
    dispose(): void {
      // 无持久资源（每次操作为独立一次性子进程）。
    },
  };
}

/**
 * DSH 宿主挂载入口（bundle 约定调用）。
 * 降级行为：二进制缺失时记录含安装路径的日志，并注册降级版工具（调用返回含安装指引的错误），
 * 不抛出、不使宿主崩溃。
 */
export function apply(ctx: BundleHost, config: AstToolsConfig = {}): void {
  // 定时器统一面（可选服务）：装配期解析一次；缺失时回落进程内定时器并只告警一次。
  const warn = (message: string): void => {
    const logger = ctx.logger?.(name) as
      { warn?: (text: string) => void } | undefined;
    if (typeof logger?.warn === "function") {
      logger.warn(message);
      return;
    }
    process.stderr.write(`[${name}] warn: ${message}\n`);
  };
  const timers = resolveClock(ctx, warn);
  const deadline = createDeadline(timers.scoped, ctx);
  let bundle: AstToolsBundle;
  try {
    bundle = createAstToolsBundle(config, deadline, (exec) =>
      ctxAstFileIo(ctx, exec),
    );
  } catch (error) {
    if (error instanceof AstGrepMissingError) {
      ctx
        .logger?.(name)
        ?.info(`ast-tools 降级（ast-grep 不可用）：${error.message}`);
      for (const def of toToolDefs(unavailableOps(error.message))) {
        ctx.tools?.register(def);
      }
      return;
    }
    throw error;
  }
  for (const def of toToolDefs(bundle)) ctx.tools?.register(def);
  ctx.logger?.(name)?.info(`ast-tools ready (ast-grep=${bundle.bin})`);
}
