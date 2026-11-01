// src/app/adapter/types/runtime.ts — 宿主运行时结构面（cordis ctx / agent / llm）

// ---------------------------------------------------------------------------
// 阶段 2 真实实现：createRealDshAdapter
// ---------------------------------------------------------------------------

/** DSH 宿主的 slim 结构面（cordis Context 的结构子集），便于独立测试。 */
export interface DshRuntime {
  on(
    event: string,
    listener: (...args: unknown[]) => unknown,
  ): (() => void) | void;
}

/** 结构型 agent（真机来自 ctx.agents.create() 的 AgentHandle.agent） */
export interface DshAgentLike {
  readonly session: { readonly id: string };
  followup(message: DshUserMessageLike): void;
  /** 官方 steer（BACKLOG TUI#36）：投递到**最近 step 边界**（运行中下一 step 认领、
   *  空闲时立即起一轮）。宿主旧版无此方法 → 可选，调用方按 fallback 降级 */
  steer?(message: DshUserMessageLike): void;
}

/** 结构型用户消息（真机应改用 createUserMessage 生成，字段同构） */
export interface DshUserMessageLike {
  /** 消息唯一 id（identified 判定依据；官方 createMessage 生成，缺则持久化校验失败） */
  readonly id?: string;
  readonly role: "user";
  readonly content: readonly { type: "text"; text: string }[];
  /** 消息 source：`user` = 真实用户输入；`plugin` 及其余 kind = 注入消息（如
   *  `tool-bootstrap` 启动自检）——注入消息不参与任务模式分类 */
  readonly source: { kind: string; plugin?: string };
}

/**
 * 结构面：官方 @deepseek-ai/dsh-commands 注册表（ctx.commands.execute）。
 * execute(agent, line, images, signal) → CommandExecution | undefined；
 * undefined 表示未命中注册表(fail-close)。与官方 packages/interaction/commands/
 * src/types.ts 契约一致(docs/host/DSH-CTX-API.md)。
 */
export interface DshCommandLike {
  execute(
    agent: unknown,
    line: string,
    images?: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> | unknown;
  /** 注册表目录（官方 commands.list(agent) → CommandDescriptor[]）；宿主未暴露时省略。
   *  仅取 name/description，调用方按宽松字段读取（unknown 收窄）。 */
  list?(agent: unknown): readonly { name?: unknown; description?: unknown }[];
}

/** ctx.get('llm') 服务（dsh-llm LlmRuntime）结构面，零运行时依赖 */
export interface LlmLike {
  listProviders?(): readonly { id?: string; name?: string }[];
  listModels?(provider: string):
    | Promise<
        readonly {
          provider?: string;
          id?: string;
          name?: string;
          description?: string;
        }[]
      >
    | readonly {
        provider?: string;
        id?: string;
        name?: string;
        description?: string;
      }[];
  /** 精确路由推理元数据（结构面：官方 LlmService.resolveModelInfo → LlmResolvedModelInfo.reasoning） */
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: unknown,
  ):
    | Promise<
        | {
            reasoning?: {
              efforts?: readonly { id?: string; name?: string }[];
              defaultEffort?: string;
            };
            context?: { contextWindow?: number };
          }
        | undefined
      >
    | {
        reasoning?: {
          efforts?: readonly { id?: string; name?: string }[];
          defaultEffort?: string;
        };
        context?: { contextWindow?: number };
      }
    | undefined;
}

export interface AgentDefaultModelLike {
  currentSelection?():
    { provider?: string; model?: string; reasoningEffort?: string } | undefined;
}
