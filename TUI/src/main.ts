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
import { normalizeThemeId, type ThemeId } from "./renderer/theme.ts";
import { App } from "./app/index.ts";
import { createProcessStatusQueries } from "./app/status.ts";
import type {
  DshAdapter,
  AgentDefaultModelLike,
  LlmLike,
  UserQuestionsLike,
} from "./app/adapter/dsh.ts";
import {
  createRealDshAdapter,
  installSessionModelSelection,
  installToolBootstrap,
  readDefaultSelection,
  type SessionModelSelectionRef,
  type DshAgentLike,
  type DshCommandLike,
  type DshRuntime,
  type DshUserMessageLike,
  type SessionQueryLike,
  type SessionStoreLike,
  type AgentRegistryLike,
} from "./app/adapter/dsh.ts";

/** 组装 renderer + app + adapter(纯组装，不设全局副作用)。 */
export function main(opts: {
  adapter: DshAdapter;
  logger?: (m: string) => void;
  /** 初始主题（默认 dark） */
  initialTheme?: ThemeId;
  /** 真实链路：流式正文放缓显示(打字机节奏)，mock demo 不传保持原速 */
  slowStream?: boolean;
  /** 思考打字机流速(字符/秒，默认 120；收到正文后自动加速到 200；由 apply 归一化) */
  streamCharsPerSecond?: number;
  /** thinking 最大显示行数(默认 4；由 apply 归一化) */
  thinkingMaxLines?: number;
  /** 用户块左缘/回复右缘对称留空(列数，默认 4；由 apply 归一化，域 0..20) */
  messageGutter?: number;
}): void {
  const renderer: Renderer = createRenderer();
  const app = new App({
    renderer,
    adapter: opts.adapter,
    status: { queries: createProcessStatusQueries(), intervalMs: 5000 },
    initialTheme: opts.initialTheme,
    slowStream: opts.slowStream,
    streamCharsPerSecond: opts.streamCharsPerSecond,
    thinkingMaxLines: opts.thinkingMaxLines,
    messageGutter: opts.messageGutter,
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
  /** 初始主题（默认 dark=fffdark；light=ffflight） */
  theme?: ThemeId;
  /** 打字机总开关（默认 true：真实链路放缓流式正文显示；false 恢复原速） */
  streamTypewriter?: boolean;
  /** 思考打字机流速（字符/秒，默认 120；收到正文后自动加速到 200；合法域 1..2000，非法回退默认） */
  streamCharsPerSecond?: number;
  /** thinking/reasoning 最大显示行数（默认 4；合法域 1..50，非法回退默认） */
  thinkingMaxLines?: number;
  /** 用户块左缘/回复右缘对称留空（列数，默认 4；合法域 0..20，非法回退默认） */
  messageGutter?: number;
  /** 锚定工具引导（两阶段工具锁定-释放，移植自 dsh-anchored-standard）。
   *  仅 deepseek-v4-pro 生效；其他模型与 false 时原样透传。默认 true。 */
  toolBootstrap?: boolean;
}

export interface TuiDisplayConfig {
  /** streamTypewriter 归一化结果 */
  streamTypewriter: boolean;
  /** streamCharsPerSecond 归一化结果（1..2000） */
  streamCharsPerSecond: number;
  /** thinkingMaxLines 归一化结果（1..50） */
  thinkingMaxLines: number;
  /** messageGutter 归一化结果（0..20，默认 4） */
  messageGutter: number;
}

/**
 * 归一化展示类配置：非法值（非有限数/越界）回退默认并发出一次性告警。
 * 纯函数，便于单测；在 apply() 配置边界集中处理，app 内不需要再判断合法性。
 */
export function normalizeTuiDisplayConfig(
  raw:
    | Partial<
        Pick<
          DshTuiConfig,
          | "streamTypewriter"
          | "streamCharsPerSecond"
          | "thinkingMaxLines"
          | "messageGutter"
        >
      >
    | undefined,
  warn: (msg: string) => void = (m) =>
    process.stderr.write("[dsh-tui] config warning: " + m + "\n"),
): TuiDisplayConfig {
  const num = (
    v: number | undefined,
    def: number,
    min: number,
    max: number,
    name: string,
  ): number => {
    if (v === undefined) return def;
    const n = Math.round(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      warn(
        `${name}=${String(v)} 非法（合法域 ${min}..${max}），回退默认 ${def}`,
      );
      return def;
    }
    return n;
  };
  return {
    // 显式给出的值就地布尔化（YAML 写 false/0 均按关闭处理），缺省开启
    streamTypewriter:
      raw?.streamTypewriter === undefined
        ? true
        : Boolean(raw.streamTypewriter),
    streamCharsPerSecond: num(
      raw?.streamCharsPerSecond,
      120,
      1,
      2000,
      "streamCharsPerSecond",
    ),
    thinkingMaxLines: num(raw?.thinkingMaxLines, 4, 1, 50, "thinkingMaxLines"),
    messageGutter: num(raw?.messageGutter, 4, 0, 20, "messageGutter"),
  };
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
          /** 与官方 AgentSetup 同构：拿到未发布的 agentCtx(结构面为 DshRuntime) */
          setup?: (agentCtx: DshRuntime) => unknown;
        }): Promise<{ agent: unknown; dispose(): Promise<void> }>;
        resume?(opts: {
          resumeSessionId: string;
          agentOptions?: Record<string, unknown>;
          setup?: (agentCtx: unknown) => unknown;
        }): Promise<{ agent: unknown; dispose(): Promise<void> }>;
      }
    | undefined;

  if (typeof agents?.create !== "function") {
    throw new Error("dsh-tui: ctx.agents.create 不可用(缺 dsh-agent-loop)");
  }

  // 模型 route 解析：显式 config > 宿主默认选择(agentDefaultModel) > 空。
  // 注意 agentDefaultModel 未在本插件 inject 中声明，须经 ctx.get() 读取
  // (cordis 严格模式禁止未注入服务的直接属性访问)。
  const defaultModelSvc = (ctx as { get?: (name: string) => unknown }).get?.(
    "agentDefaultModel",
  ) as AgentDefaultModelLike | undefined;
  const defaultModel = defaultModelSvc?.currentSelection?.() as
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

  // 会话内模型选择引用：仅显式 config 固定种子；宿主默认(settings)交由实时兜底
  // `readDefaultSelection(defaultModelSvc)`，避免启动时序吞掉热加载的设置。
  // /model 切换只改该引用，绝不调用宿主的 saveSelection——避免覆盖配置中的默认模型。
  const sessionModel: SessionModelSelectionRef = {
    current:
      config?.provider && config?.model
        ? {
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort
              ? { reasoningEffort: config.reasoningEffort }
              : {}),
          }
        : undefined,
  };

  const { randomUUID } = await import("node:crypto");
  const sessionId = "tui-" + randomUUID();
  // 会话钩子（模型选择 + 锚定工具引导）：create/resume 共用同一 setup。
  // 注意：返回离谱值会被宿主当 commit 处理失败，故 setup 只 void 挂载。
  const makeSetup = (): ((agentCtx: unknown) => unknown) => (agentCtx) => {
    void installSessionModelSelection(
      agentCtx as DshRuntime,
      sessionModel,
      () => readDefaultSelection(defaultModelSvc),
    );
    // 锚定工具引导：仅 deepseek-v4-pro 触发锁定-释放；开关可配置关停
    void installToolBootstrap(agentCtx as DshRuntime, {
      enabled: config?.toolBootstrap ?? true,
    });
  };
  const handle = await agents.create({
    sessionId,
    meta: { cwd: config?.cwd ?? process.cwd() },
    agentOptions: route,
    setup: makeSetup(),
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
    // 会话切换（resume）：agents 注册表 + 与 create 相同的钩子/路由，handle 由 adapter 接管释放
    agents: agents as AgentRegistryLike | undefined,
    setup: makeSetup(),
    agentOptions: route,
    handleDispose: () => handle.dispose(),
    commands,
    llm: (ctx as { get?: (name: string) => unknown }).get?.("llm") as
      LlmLike | undefined,
    sessionModel,
    // 只读兜底：会话未切换时 /model 目录/状态显示与组装默认取宿主实时值(settings 热更新生效)
    defaultModel: defaultModelSvc,
    approvalTimeoutMs: config?.approvalTimeoutMs ?? 60_000,
    // DSH 提问服务（ctx.get('userQuestions')，0.1.1 单 provider；缺失时提问不可用但适配层正常启动）
    userQuestions: (ctx as { get?: (name: string) => unknown }).get?.(
      "userQuestions",
    ) as UserQuestionsLike | undefined,
    // 历史会话查询服务（ctx.get('sessionQuery')；缺失时 /session 提示不可用）
    sessionQuery: (ctx as { get?: (name: string) => unknown }).get?.(
      "sessionQuery",
    ) as SessionQueryLike | undefined,
    // 会话存储服务（ctx.get('sessions')；live 会话读取原始事件需经它，缺失时降级 readSurface/readSession）
    sessions: (ctx as { get?: (name: string) => unknown }).get?.("sessions") as
      SessionStoreLike | undefined,
  });

  // 展示类配置在配置边界一次性归一化（非法值告警并回退默认）
  const display = normalizeTuiDisplayConfig(config);
  main({
    adapter,
    initialTheme: normalizeThemeId(config?.theme ?? undefined),
    logger: (msg) => process.stderr.write("[dsh-tui] " + msg + "\n"),
    // 真实接入链路：打字机放缓默认开启，streamTypewriter: false 可关闭
    slowStream: display.streamTypewriter,
    streamCharsPerSecond: display.streamCharsPerSecond,
    thinkingMaxLines: display.thinkingMaxLines,
    messageGutter: display.messageGutter,
  });
  // renderer 的退出钩子(SIGINT/TERM/Esc → close()) 负责进程退出；此处兜底
  // 清理 agent(避免残留运行中的 loop)。
  process.once("exit", () => {
    void handle.dispose();
  });
}
