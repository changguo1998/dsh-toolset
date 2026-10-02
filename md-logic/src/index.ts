/**
 * md-logic 插件入口（DSH bundle 集成面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / inject / Config / apply，Config 以类型声明给出（无运行时 schema，宿主不校验，配置原样
 * 透传给 apply）。cordis 加载器识别 named apply 导出；与 ast-tools / fs-digest 同款挂载形态。
 *
 * 解析器为 `marked`（唯一运行时依赖，零传递依赖；选型理由见 README「解析选型」）；
 * 只读、纯函数解析，不写文件、不注册命令，唯一副作用是注册 `md_logic` 工具。
 */

import { DEFAULT_MAX_BYTES, mdLogicTool } from "./tools.ts";

export { DEFAULT_MAX_BYTES, mdLogicTool, resolveExecCwd } from "./tools.ts";
export { detectFrontmatter, parseMarkdownDocument } from "./parse.ts";
export {
  findSections,
  flattenSections,
  listLinks,
  queryBlocks,
  sectionAt,
} from "./query.ts";
export type {
  BlockQuery,
  FlatSection,
  LinkQuery,
  SectionQuery,
} from "./query.ts";
export {
  RENDER_LIMIT,
  renderBlocks,
  renderLinks,
  renderStructure,
} from "./render.ts";
export type {
  FrontmatterInfo,
  MarkdownDocument,
  MdBlock,
  MdBlockKind,
  MdLink,
  MdLinkKind,
  ParseOptions,
  SectionNode,
} from "./types.ts";

/** 插件名（bundle 标识，cordis.patch.yml insert 条目同名）。 */
export const name = "md-logic";

/** 注入面：tools（注册 md_logic；解析本身不依赖任何宿主服务）。 */
export const inject = ["tools"];

/** 结构化宿主 ctx（最小 DSH cordis 形态）：可选 logger 与工具注册面。 */
export interface BundleHost {
  logger?(ns: string): { info(message: string): void };
  tools?: { register(def: unknown): unknown };
}

/** 插件配置（Config 契约名）。 */
export interface MdLogicConfig {
  /** 读取文件尺寸上限（字节），缺省 1MB；超限报错而不截断。 */
  maxBytes?: number;
}

/** Config 契约别名（仅类型级导出，无运行时校验）。 */
export type Config = MdLogicConfig;

/** DSH 宿主挂载入口（bundle 约定调用）。 */
export function apply(ctx: BundleHost, config: MdLogicConfig = {}): void {
  const tool = mdLogicTool(config.maxBytes ?? DEFAULT_MAX_BYTES);
  ctx.tools?.register(tool);
  ctx.logger?.(name).info("md-logic ready (tool=md_logic)");
}
