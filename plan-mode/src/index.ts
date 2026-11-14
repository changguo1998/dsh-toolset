/**
 * plan-mode 插件入口（DSH bundle 接入面）。
 *
 * 角色（决策项 6）：**流程定义插件**，与 flow-track 平级——本包只定义 plan 三段
 * （探索 / 计划 / 实施）并提供入口工具 `plan_start`；建树经 task-engine 的编程服务面
 * `composeFromNodes`，建树之后节点推进 / 校验 / 验收 / 推送全部由 task-engine 接管。
 *
 * 本包不注入上下文（任务推送由 task-engine 取当前节点、pin-note 保持），也不持有流程开关
 * （流程选择由 flow-arbiter 统一仲裁，阶段 4 接入）。
 *
 * 降级：`tools` 是硬依赖（装配期注册工具面）；`taskEngine` 可选——缺席或未暴露
 * `composeFromNodes` 时 `plan_start` 返回可读错误，不阻断启动。
 */

import { wrapToolDefinition } from "@dsh-toolset/tool-surface";

import { planStartTool, type PlanComposeFace } from "./plan-start.ts";

export const name = "plan-mode";

/** 注入面：装配期要注册工具面，`tools` 是硬依赖。 */
export const inject = ["tools"];

/** 技术面结构（插件上下文的最小形态）。 */
interface PluginContext {
  get?(name: string): unknown;
  tools?: { register(def: unknown): unknown };
  logger?: { warn?(message: string): void };
}

/** `taskEngine` 服务面里本包用到的部分。 */
interface TaskEngineFace {
  composeFromNodes?(
    parentId: string | undefined,
    nodes: unknown[],
  ): Promise<{
    ok: boolean;
    accepted?: boolean;
    next?: string | null;
    feedback?: string;
  }>;
}

/** 读一个服务（`ctx.get` 优先，退回属性读；缺失一律降级）。 */
function readService<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    const value = ctx.get?.(name);
    if (value !== undefined) return value as T;
  } catch {
    /* ctx.get 抛错：落到属性读 */
  }
  try {
    return (ctx as Record<string, unknown>)[name] as T | undefined;
  } catch {
    return undefined;
  }
}

/** 建树帧 id 前缀（进程内递增 + 时间戳基数：跨轮 / 多次建树都不撞 id）。 */
let planSeq = 0;
function nextPlanPrefix(): string {
  planSeq += 1;
  return `plan-${Date.now().toString(36)}-${planSeq}`;
}

export function apply(ctx: unknown, _config?: unknown): void {
  const c = (ctx ?? {}) as PluginContext;
  const logger = readService<{ warn?(message: string): void }>(c, "logger");
  const warn = (message: string): void => {
    if (typeof logger?.warn === "function") {
      logger.warn(`[plan-mode] ${message}`);
      return;
    }
    process.stderr.write(`[plan-mode] warn: ${message}\n`);
  };
  const composeOf = (): PlanComposeFace | undefined => {
    const face = readService<TaskEngineFace>(c, "taskEngine");
    const entry = face?.composeFromNodes;
    if (face === undefined || typeof entry !== "function") return undefined;
    return async (parentId, nodes) => entry.call(face, parentId, nodes);
  };
  if (composeOf() === undefined) {
    warn("ctx.taskEngine 未暴露 composeFromNodes，plan_start 暂不可用");
  }
  const tools = readService<{ register(def: unknown): unknown }>(c, "tools");
  if (tools === undefined || typeof tools.register !== "function") {
    warn("ctx.tools 不可用，plan_start 不会出现");
    return;
  }
  try {
    // 注册前套包装层: 模型侧只见短说明与宽松占位, 全文与完整 schema 留给 consult_tools 投递
    tools.register(
      wrapToolDefinition(
        planStartTool({ compose: composeOf, prefix: nextPlanPrefix }),
      ),
    );
  } catch (error) {
    warn(`工具 plan_start 注册失败：${String(error)}`);
  }
}
