// src/main.ts — 程序入口
//
// 双角色：
//   1. DSH 插件(bundle)入口：导出 `{ name, inject, apply }`(注意：cordis 要求
//      Config 为 schemastery Schema 才导出 `Config`——本项目零运行时依赖、不引入
//      schemastery，故不导出 Config，loader 对无 schema 插件直接透传 config)，由
//      cordis/dsh 以 `name: '@dsh-toolset/dsh-tui'` 加载，apply(ctx) 在真实
//      profile 内做会话/agent 引导并组装 renderer + app + real adapter。
//      注意：本模块作为插件被 import 时绝不能有顶层副作用(如直接 start)，
//      否则 loader 阶段就会抢占 TTY。
//   2. 独立 `main()`：供 bin/dsh-tui.js 显式调用(阶段 3 再指向 profile boot)。

import { createRenderer, type Renderer } from "./renderer/index.ts";
import { App } from "./app/index.ts";
import { createProcessStatusQueries } from "./app/status.ts";
import type { DshAdapter } from "./app/adapter/dsh.ts";
import {
  createRealDshAdapter,
  type DshAgentLike,
  type DshCommandLike,
  type DshRuntime,
  type DshUserMessageLike,
} from "./app/adapter/dsh.ts";

/** 组装 renderer + app + adapter(纯组装，不设全局副作用)。 */
export function main(opts: {
  adapter: DshAdapter;
  logger?: (m: string) => void;
}): void {
  const renderer: Renderer = createRenderer();
  const app = new App({
    renderer,
    adapter: opts.adapter,
    status: { queries: createProcessStatusQueries(), intervalMs: 5000 },
  });
  app.setLogger(opts.logger ?? ((msg) => void msg));
  app.start();
  void renderer;
}

// ---------------------------------------------------------------------------
// cordis 插件入口
// ---------------------------------------------------------------------------

export const name = "@dsh-toolset/dsh-tui";

export const inject = ["agents"];

export interface DshTuiConfig {
  /** 创建会话时的 cwd(默认 process.cwd()) */
  cwd?: string;
  /** 审批弹窗超时(ms，默认 60s) */
  approvalTimeoutMs?: number;
  /** 备用模型 route(config 提供了就用它；否则取 agentDefaultModel 选择) */
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

/**
 * DSH 宿主加载本 bundle 时调用：创建/拉起 agent，组装真实链路并启动 TUI。
 * ctx 为 cordis Context(结构上满足 DshRuntime)，此处只做窄化。
 *
 * SAFETY: apply 由 cordis 注入完整 Context，本文件刻意不依赖 @deepseek-ai/*
 * 类型(保持零运行时依赖)，用 DshRuntime/DshAgentLike 结构面访问——所有消费
 * 字段(session.id、followup、agents.create、agentDefaultModel)与官方 dsh 公开
 * 契约一致，见仓库根 DSH-CTX-API.md §4 与 @deepseek-ai/dsh-agent-default-model。
 * 若 DSH 升级破坏形状，真机环境会立即暴露。
 */
export async function apply(
  ctx: unknown,
  config?: DshTuiConfig,
): Promise<void> {
  const runtime: DshRuntime = ctx as DshRuntime;
  const agents = (ctx as { agents?: unknown }).agents as
    | {
        create(opts: {
          sessionId: string;
          meta?: { cwd?: string };
          agentOptions?: Record<string, unknown>;
        }): Promise<{ agent: unknown; dispose(): Promise<void> }>;
      }
    | undefined;

  if (typeof agents?.create !== "function") {
    throw new Error("dsh-tui: ctx.agents.create 不可用(缺 dsh-agent-loop)");
  }

  // 模型 route 解析：显式 config > 宿主默认选择(agentDefaultModel) > 空。
  // 注意 agentDefaultModel 未在本插件 inject 中声明，须经 ctx.get() 读取
  // (cordis 严格模式禁止未注入服务的直接属性访问)。
  const defaultModel = (
    (ctx as { get?: (name: string) => unknown }).get?.("agentDefaultModel") as
      { currentSelection?(): unknown } | undefined
  )?.currentSelection?.() as
    { provider?: string; model?: string; reasoningEffort?: string } | undefined;
  const route: { provider?: string; model?: string; reasoningEffort?: string } =
    config?.provider && config?.model
      ? {
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort
            ? { reasoningEffort: config.reasoningEffort }
            : {}),
        }
      : defaultModel?.provider && defaultModel?.model
        ? {
            provider: defaultModel.provider,
            model: defaultModel.model,
            ...(defaultModel.reasoningEffort
              ? { reasoningEffort: defaultModel.reasoningEffort }
              : {}),
          }
        : {};

  const { randomUUID } = await import("node:crypto");
  const sessionId = "tui-" + randomUUID();
  const handle = await agents.create({
    sessionId,
    meta: { cwd: config?.cwd ?? process.cwd() },
    agentOptions: route,
  });

  const rawAgent = handle.agent as {
    session: { id: string };
    followup(m: DshUserMessageLike): void;
    /** DSH Agent.cancel(cause)：中断当前 turn/step（{kind:'user'} 为用户手动打断） */
    cancel?(cause: { kind: "user" }): void;
  };
  // SAFETY: agents.create 的返回契约(AgentHandle.agent)来自 @deepseek-ai/dsh-agent，
  // agent.session.id 与 agent.followup(UserMessage) 已获官方源码确认(DSH-CTX-API.md)。
  const agentLike: DshAgentLike = {
    session: rawAgent.session,
    followup: (m) => rawAgent.followup(m),
  };

  if (!route.provider || !route.model) {
    process.stderr.write(
      "[dsh-tui] warn: model route 为空，agent 将无法发起请求(配置 provider/model 或环境默认)\n",
    );
  }

  // slash 命令注册表：官方 dsh-commands 服务(cordis 挂载，未在本插件 inject 声明，
  // 经 ctx.get 读取)。真实 agent 用于注册表作用域查找(runCommand 需要完整 Agent，
  // 而 app 层只有瘦 DshAgentLike)。结构面见 DshCommandLike(与 DSH-CTX-API.md 契约一致)。
  const commands = (ctx as { get?: (name: string) => unknown }).get?.(
    "commands",
  ) as DshCommandLike | undefined;

  const adapter = createRealDshAdapter({
    runtime,
    sessionId: agentLike.session.id,
    agent: agentLike,
    commandAgent: rawAgent,
    interrupt: () => rawAgent.cancel?.({ kind: "user" }),
    commands,
    approvalTimeoutMs: config?.approvalTimeoutMs ?? 60_000,
  });

  main({
    adapter,
    logger: (msg) => process.stderr.write("[dsh-tui] " + msg + "\n"),
  });

  // renderer 的退出钩子(SIGINT/TERM/Esc → close()) 负责进程退出；此处兜底
  // 清理 agent(避免残留运行中的 loop)。
  process.once("exit", () => {
    void handle.dispose();
  });
}
