/**
 * tool-surface 插件入口（DSH bundle 接入面）。
 *
 * 本包只有两层能力, 都不注册模型侧工具、不注入上下文:
 *
 * - 库面: `wrapToolDefinition(def)` —— 各工具包在 `ctx.tools.register` 前调用, 把注册定义换成
 *   「短说明 + 宽松占位」, 完整说明与完整参数 schema 收进 catalog, 派发前按全文严格校验。
 * - 服务面: `toolSurface.lookup(name)` / `toolSurface.list()` —— 只读, 供 tool-consult 在
 *   揭示后投递完整说明与 `input_schema`。
 *
 * 为什么单独成包（决策 10）: `tool-consult` 可被禁用, 且各注册工具包会反向依赖它; 包装层与
 * 服务面必须独立于它。
 *
 * 降级: `ctx.provide` 缺席时只告警 —— 包装函数仍可用（catalog 在模块内）, 只是 tool-consult
 * 读不到服务面, 揭示退回旧路径。
 */

import { listSurface, lookupSurface } from "./definition.ts";
import type { ToolSurfaceFace } from "./definition.ts";

export {
  listSurface,
  lookupSurface,
  resetSurfaceCatalog,
  wrapToolDefinition,
} from "./definition.ts";
export type {
  SurfaceEntry,
  ToolSurfaceFace,
  WrapTarget,
} from "./definition.ts";

export const name = "tool-surface";

/** 不依赖任何宿主服务: 包装是纯函数, 服务面自带。 */
export const inject = [];

/** 对外只读服务面: 完整说明与完整参数 schema。 */
export const provide = ["toolSurface"];

/** 插件上下文的结构化面。 */
interface PluginContext {
  provide?(serviceName: string, value: unknown): unknown;
  logger?: { warn?(message: string): void };
}

/** 读告警出口（logger 缺席时写 stderr, 与仓内其它包同口径）。 */
function warnOf(ctx: PluginContext): (message: string) => void {
  const logger = ctx.logger;
  return (message: string): void => {
    if (typeof logger?.warn === "function") {
      logger.warn(`[tool-surface] ${message}`);
      return;
    }
    process.stderr.write(`[tool-surface] warn: ${message}\n`);
  };
}

/**
 * 挂载: 暴露 `toolSurface` 只读服务面。
 *
 * @param ctx 插件上下文（只需 `provide`, 其余忽略）。
 * @returns dispose（无外部登记, 空函数）。
 */
export function apply(ctx: unknown): () => void {
  const c = (ctx ?? {}) as PluginContext;
  const warn = warnOf(c);
  if (typeof c.provide !== "function") {
    warn("ctx.provide 不可用, tool-consult 读不到完整说明与完整参数 schema");
    return () => {};
  }
  const face: ToolSurfaceFace = {
    lookup: (toolName: string) => lookupSurface(toolName),
    list: () => listSurface(),
  };
  try {
    c.provide("toolSurface", face);
  } catch (error) {
    warn(`服务面 toolSurface 暴露失败（忽略）：${String(error)}`);
  }
  return () => {};
}
