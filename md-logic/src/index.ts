/**
 * md-logic 插件入口（DSH bundle 集成面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / inject / Config / apply，Config 以类型声明给出（无运行时 schema，宿主不校验，配置原样
 * 透传给 apply）。cordis 加载器识别 named apply 导出；与 ast-tools / fs-digest 同款挂载形态。
 *
 * 解析器为 `marked`（唯一运行时依赖，零传递依赖；选型理由见 README「解析选型」）；
 * 解析本身是纯函数（读面不写文件、不注册命令）；唯一副作用是注册 `md_logic` 工具——工具面
 * 含唯一写动作 `replace`（按节整节替换 / 删除，安全语义见 md-logic/src/edit.ts 与 README「改写面」）。
 *
 * 文件读写只经 `MdFileIo`（`md-logic/src/io.ts`）：插件侧由 `apply` 注入 `ctx.fs` 实现
 * （`md-logic/src/ctx-fs-io.ts`），库面 / 单测缺省用 `node:fs` 实现；`ctx.fs` 缺失时不回落。
 */

import { ctxMdFileIo, type MdFsHostLike } from "./ctx-fs-io.ts";
import { wrapToolDefinition } from "@dsh-toolset/tool-surface";
import { DEFAULT_MAX_BYTES, mdLogicTool } from "./tools.ts";

export { DEFAULT_MAX_BYTES, mdLogicTool, resolveExecCwd } from "./tools.ts";
export type { MdToolOptions } from "./tools.ts";
export {
  isMdFileErrorCode,
  MdFileError,
  mdFileErrorText,
  nodeMdFileIo,
} from "./io.ts";
export type {
  MdFileErrorCode,
  MdFileInfo,
  MdFileIo,
  MdFileTarget,
  MdResolveOptions,
  MdWriteIntent,
  MdWriteOutcome,
  NodeMdFileIoOptions,
} from "./io.ts";
export { ctxMdFileIo } from "./ctx-fs-io.ts";
export type {
  MdFsHostLike,
  MdFsServiceLike,
  MdObservation,
  MdSandboxPolicyServiceLike,
  MdWorkingDirectoryLike,
} from "./ctx-fs-io.ts";
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
  renderReplace,
  renderStructure,
} from "./render.ts";
export {
  replaceSections,
  replaceSectionsFile,
  sectionHash,
  type EditFailureCode,
  type ReplaceFileOptions,
  type ReplaceOutcome,
  type SectionEdit,
} from "./edit.ts";
export type {
  FrontmatterInfo,
  MarkdownDocument,
  MdBlock,
  MdBlockKind,
  MdLink,
  MdLinkKind,
  ParseOptions,
  SectionNode,
  ToolExecLike,
} from "./types.ts";

/** 插件名（bundle 标识，cordis.patch.yml insert 条目同名）。 */
export const name = "md-logic";

/** 注入面：tools 注册工具; fs 是 `md_logic` 的文件读写面（缺它时工具调用返回可行动错误）。 */
export const inject = ["tools", "fs"];

/**
 * 结构化宿主 ctx（最小 DSH cordis 形态）：可选 logger 与工具注册面,
 * 另含 `MdFsHostLike`（`fs` / `workingDirectory` / `sandboxPolicy` / `waterfall` / `emit`）。
 */
export interface BundleHost extends MdFsHostLike {
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
  const tool = mdLogicTool(config.maxBytes ?? DEFAULT_MAX_BYTES, {
    host: ctx,
    ioFor: (exec) => ctxMdFileIo(ctx, exec),
  });
  ctx.tools?.register(wrapToolDefinition(tool));
  ctx.logger?.(name)?.info("md-logic ready (tool=md_logic)");
}
