/**
 * ast-tools 插件入口（DSH bundle 集成面）。
 *
 * 契约对齐 DSH-CTX-API.md §0：插件 bundle 约定 `export { name, Config, apply }`
 * （cordis 加载器识别 named apply 导出；与 knowledge-base/TUI 同款挂载形态，
 * 真实宿主侧挂载由部署时人工确认）。
 *
 * 四个操作 search/replace/outline/rules 均委托系统 ast-grep CLI 子进程
 * （选型依据见 README「二进制选型」）；二进制缺失时 apply 走降级：
 * 记录含安装路径的日志而不抛出，宿主不受影响。
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
} from "./types.ts";
import { searchAst } from "./search.ts";
import { replaceAst } from "./replace.ts";
import { outlineFile } from "./outline.ts";
import { runRules } from "./rules.ts";

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
} from "./types.ts";

/** 插件名（bundle 标识，cordis.patch.yml insert 条目同名）。 */
export const name = "ast-tools";

/** 结构化宿主 ctx（最小 DSH cordis 形态）：可选 logger。 */
export interface BundleHost {
  logger?(ns: string): { info(message: string): void };
}

/** 插件配置（Config 契约名）。 */
export interface AstToolsConfig {
  /** 显式指定 ast-grep 二进制路径（探测顺序中优先级最高）。 */
  bin?: string;
  /** 子进程超时（毫秒），缺省 30s。 */
  timeoutMs?: number;
}

/** Config 契约别名（DSH bundle 约定 export { name, Config, apply }）。 */
export type Config = AstToolsConfig;

/** 可复用 bundle 实例（核心工厂产物，也是宿主侧可消费的服务形态）。 */
export interface AstToolsBundle {
  /** 已解析的 ast-grep 二进制路径。 */
  readonly bin: string;
  /** AST 模式搜索。 */
  search(params: SearchParams): Promise<AstMatch[]>;
  /** 结构化替换（可选写回）。 */
  replace(params: ReplaceParams): Promise<ReplaceResult>;
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
 */
export function createAstToolsBundle(
  config: AstToolsConfig = {},
): AstToolsBundle {
  const bin = ensureAstGrepBin(config.bin);
  const base: AstOptions = {
    bin,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  return {
    bin,
    search: (params) => searchAst(params, base),
    replace: (params) => replaceAst(params, base),
    outline: (params) => outlineFile(params, base),
    rules: (params) => runRules(params, base),
    dispose(): void {
      // 无持久资源（每次操作为独立一次性子进程）。
    },
  };
}

/**
 * DSH 宿主挂载入口（bundle 约定调用）。
 * 降级行为：二进制缺失时记录含安装路径的日志并禁用插件，不抛出。
 */
export function apply(ctx: BundleHost, config: AstToolsConfig = {}): void {
  try {
    const bundle = createAstToolsBundle(config);
    ctx.logger?.(name).info(`ast-tools ready (ast-grep=${bundle.bin})`);
  } catch (error) {
    if (error instanceof AstGrepMissingError) {
      ctx.logger?.(name).info(`ast-tools 降级禁用：${error.message}`);
      return;
    }
    throw error;
  }
}
