// src/host.ts — 宿主结构面：本插件消费的服务面最小形态与受保护读取
//
// 只按结构子集描述宿主（子代理 / workflow / 模型 / 计量 / 投影 / 审批 / 工具注册），
// 不 import 宿主包；服务缺失一律由调用方降级。

// ---------------------------------------------------------------------------
// executor 后端接线（① 发起 / ② 模型与计量）——结构面访问宿主，缺面 fail-closed
// 契约来源：docs/host/HOST-PACKAGES.md 与宿主包类型（@deepseek-ai/dsh-subagent 等）
// ---------------------------------------------------------------------------

/** 宿主子代理面（`ctx.subagents`，@deepseek-ai/dsh-subagent）最小形态 */
export interface SubagentsLike {
  start(
    name: string,
    request: Record<string, unknown>,
  ): Promise<{
    id: string;
    localAgent?: { session?: unknown };
    result: Promise<{
      output?: unknown;
      stopReason?: string;
      diagnostic?: string;
      /** 请求了 `outputSchema` 时宿主校验后的结构化产出 */
      structured?: unknown;
    }>;
    dispose(): Promise<void>;
  }>;
  getProvider?(name: string): {
    capabilities?: {
      agentOptions?: boolean;
      outputSchema?: boolean;
      /** 子代理工具面收窄（宿主 `tools.restrict`；`spawn` provider 声明支持） */
      toolFilter?: boolean;
    };
  };
}

/** 宿主 workflow 面（`ctx.workflowEngine`，@deepseek-ai/dsh-workflow[-ptc]）最小形态 */
export interface WorkflowEngineLike {
  start(request: Record<string, unknown>): {
    result: Promise<{
      value?: unknown;
      stopReason?: string;
      error?: string;
      /** 本次 run 启动的子代理数（失败反馈里带上，便于定位） */
      agentsStarted?: number;
    }>;
    dispose(): Promise<void>;
  };
}

/** 宿主默认模型面（`ctx.agentDefaultModel`）最小形态：只读当前选择 */
export interface AgentDefaultModelLike {
  currentSelection(): { provider?: string; model?: string };
}

/** 宿主 token 计量面（`ctx.tokenMeter`）最小形态（pressure 口径：上下文压力） */
export interface TokenMeterLike {
  measure(session: unknown): { totalTokens?: number };
}

/** 宿主会话投影注册表（`ctx.sessionProjections`）最小形态：只读某会话的投影状态 */
export interface ProjectionRegistryLike {
  stateOf(session: unknown, key: string): unknown;
}

/** 子代理 provider（一次性、不继承父上下文；fork 非本包职责） */
export const SUBAGENT_PROVIDER = "spawn";

export interface ToolsRegistrar {
  register(def: unknown): void;
}

/** 可选服务读取（cordis 严格模式下未注入服务的直接属性访问会抛；缺失一律降级） */
export function readService<T>(ctx: unknown, name: string): T | undefined {
  try {
    return (ctx as { get?: (n: string) => unknown }).get?.(name) as
      T | undefined;
  } catch {
    return undefined;
  }
}

export interface ApprovalLike {
  request(req: {
    agent?: unknown;
    toolName: string;
    callId?: string;
    reason?: string;
    signal?: unknown;
  }): Promise<unknown>;
}
