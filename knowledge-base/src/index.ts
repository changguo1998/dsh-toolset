/**
 * knowledge-base 插件入口。
 * 契约对齐 DSH-CTX-API.md：插件 bundle 约定 `export { name, inject, Config, apply }`。
 * @deepseek-ai/cordis 为 dsh 仓库 workspace 包（未发布到 npm），故 Context 用结构化类型声明。
 * 当前为脚手架占位；schema/接口/事件接入在后续阶段落地。
 */

/** 插件 bundle 契约所需的宿主上下文最小形态（logger 面）。 */
export interface HostContext {
  logger(name: string): { info(message: string): void }
}

export const name = 'knowledge-base'

export function apply(ctx: HostContext): void {
  ctx.logger('knowledge-base').info('knowledge-base 插件已加载（脚手架）')
}
