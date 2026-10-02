/**
 * md-map 插件入口（DSH bundle 集成面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, provide, Config, apply }）：
 * 本包导出 name / inject / provide / apply，Config 以类型声明给出（无运行时 schema，配置原样透传给
 * apply）。cordis 加载器识别 named apply 导出；与 code-map / ast-tools 同款挂载形态。
 *
 * 职责：Markdown 的**项目级**结构与引用分析（文档 / 锚点 / 引用边 / 影响面 / 断链）；
 * 单文件结构解析复用 `@dsh-toolset/md-logic`（不重复实现 Markdown 解析）。
 * 只读：不写任何文件；索引惰性（首次 `md_map action=index` 时构建）。
 */

import { createMdMapService, type MdMapService } from "./service.ts";
import { mdMapTool, resolveExecCwd } from "./tools.ts";
import type { MdMapOptions } from "./types.ts";

export { DEFAULT_EXCLUDES, DEFAULT_MAX_FILES, buildIndex, findMarkdownFiles } from "./indexer.ts";
export {
  buildAnchors,
  candidateDocPaths,
  dirOf,
  isExternal,
  resolveDocPath,
  scanWikiLinks,
  slugify,
  splitHref,
  wikiCandidates,
} from "./links.ts";
export type { WikiLink } from "./links.ts";
export {
  callers,
  getDoc,
  impact,
  orphans,
  report,
  resolveDocRef,
  summary,
  topBacklinks,
} from "./query.ts";
export {
  RENDER_LIMIT,
  renderCallers,
  renderImpact,
  renderIndex,
  renderOrphans,
  renderReport,
  renderSummary,
} from "./render.ts";
export { createMdMapService, mdMapTool, resolveExecCwd };
export type { MdMapService } from "./service.ts";
export type {
  MdBrockenLink,
  MdCaller,
  MdDoc,
  MdEdge,
  MdEdgeKind,
  MdImpactLayer,
  MdMapIndex,
  MdMapOptions,
  MdMapReport,
} from "./types.ts";

/** 插件名（bundle 标识，cordis.patch.yml insert 条目同名）。 */
export const name = "md-map";

/** 注入面：tools（注册 md_map）。 */
export const inject = ["tools"];

/** 提供面：`mdMap`（供命令侧 / 其它插件读最近一次索引）。 */
export const provide = ["mdMap"];

/** 结构化宿主 ctx（最小 DSH cordis 形态）。 */
export interface BundleHost {
  logger?(ns: string): { info(message: string): void };
  tools?: { register(def: unknown): unknown };
  provide?(key: string, value: unknown): unknown;
}

/** Config 契约别名（仅类型级导出，无运行时校验；字段见 types.ts 的 MdMapOptions）。 */
export type Config = MdMapOptions;

/** 最近一次构建的服务实例（provide 面供命令侧读取）。 */
let activeService: MdMapService | undefined;

/** 取当前服务（未挂载时 undefined）。 */
export function getMdMapService(): MdMapService | undefined {
  return activeService;
}

/** 取当前索引摘要（未索引时 `{ready:false}`）。 */
export function getMdMapSummary(): ReturnType<MdMapService["summary"]> {
  return activeService?.summary() ?? { ready: false };
}

/** DSH 宿主挂载入口（bundle 约定调用）：惰性、防御，注册失败只告警。 */
export function apply(
  ctx: BundleHost,
  config: MdMapOptions = {},
): void {
  const warn = (message: string): void => {
    ctx.logger?.(name).info(message) ??
      process.stderr.write(`[md-map] ${message}\n`);
  };
  const service = createMdMapService(config);
  activeService = service;
  if (ctx.tools !== undefined && typeof ctx.tools.register === "function") {
    try {
      ctx.tools.register(mdMapTool(service));
    } catch (error) {
      warn(`md_map 工具注册失败：${String(error)}`);
    }
  }
  if (typeof ctx.provide === "function") {
    ctx.provide("mdMap", {
      getService: () => getMdMapService(),
      getSummary: () => getMdMapSummary(),
    });
  }
  ctx.logger?.(name).info("md-map ready (tool=md_map)");
}
