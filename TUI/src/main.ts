// src/main.ts — 程序入口
//
// 双角色：
//   1. DSH 插件(bundle)入口：导出 `{ name, inject, apply }`(注意：cordis 要求
//      Config 为 schemastery Schema 才导出 `Config`——本项目零运行时依赖、不引入
//      schemastery，故不导出 Config，loader 对无 schema 插件直接透传 config)，由
//      cordis/dsh 以 `name: '@dsh-toolset/tui'` 加载，apply(ctx) 在真实
//      profile 内做会话/agent 引导并组装 renderer + app + real adapter。
//      注意：本模块作为插件被 import 时绝不能有顶层副作用(如直接 start)，
//      否则 loader 阶段就会抢占 TTY。
//   2. 独立 `main()`：供 bin/tui.js 显式调用(阶段 3 再指向 profile boot)。

import { createRenderer, type Renderer } from "./renderer/index.ts";
import { normalizeThemeId, type ThemeId } from "./renderer/theme.ts";
import { resolveThemes } from "./renderer/theme-config.ts";
import { App } from "./app/index.ts";
import { loadTuiConfig } from "./app/config.ts";
import {
  createProcessStatusQueries,
  type StatusQueries,
} from "./app/status.ts";
import type {
  DshAdapter,
  AgentDefaultModelLike,
  LlmLike,
} from "./app/adapter/dsh.ts";
import {
  createRealDshAdapter,
  installSessionModelSelection,
  installToolBootstrap,
  listSessionRecords,
  pickRecentSession,
  readDefaultSelection,
  type SessionModelSelectionRef,
  type DshAgentLike,
  type DshCommandLike,
  type DshRuntime,
  type DshUserMessageLike,
  type SessionQueryLike,
  type SessionStoreLike,
  type AgentRegistryLike,
  type PermissionPresetServiceLike,
  type AgentPresetsLike,
  type JobsLike,
  type SessionTitleLike,
  type SkillsLike,
  type SubagentsLike,
  type ToolsLike,
  type SettingsLike,
  type TaskEngineLike,
  type SecurityGuardLike,
  type KnowledgeServiceLike,
  type MetricLoopLike,
  type GoalContractServiceLike,
  type WorkflowEngineLike,
  type WebSearchLike,
} from "./app/adapter/dsh.ts";

/** 组装 renderer + app + adapter(纯组装，不设全局副作用)。 */
export function main(opts: {
  adapter: DshAdapter;
  logger?: (m: string) => void;
  /** 初始主题（默认 dark） */
  initialTheme?: ThemeId;
  /** 用户块左缘/回复右缘对称留空(列数，默认 4；由 apply 归一化，域 0..20) */
  /** 用户块左缘/回复右缘对称留空(列数，默认 4；由 apply 归一化，域 0..20) */
  messageGutter?: number;
  /** 测试注入：替代真实终端 renderer（缺省 createRenderer()） */
  renderer?: Renderer;
  /** 测试注入：替代真实状态查询（缺省 createProcessStatusQueries()） */
  statusQueries?: StatusQueries;
}): () => void {
  // 主题调色板配置解析（tui.config.json theme 段；告警经 logger 输出，避免"改了未生效"）
  const tuiConfig = loadTuiConfig();
  const resolvedThemes = resolveThemes(tuiConfig.theme);
  const configLogger = opts.logger ?? ((msg: string) => void msg);
  for (const warning of resolvedThemes.warnings) configLogger(warning);
  const renderer: Renderer =
    opts.renderer ?? createRenderer({ themes: resolvedThemes.themes });
  const app = new App({
    renderer,
    adapter: opts.adapter,
    status: {
      queries: opts.statusQueries ?? createProcessStatusQueries(),
      intervalMs: 5000,
    },
    ...tuiConfig.layout,
    notify: tuiConfig.notify,
    // 自动清理空会话：缺省开启（未配置 session.autoCleanEmpty → true）；显式 false 关闭
    autoCleanEmpty: tuiConfig.session?.autoCleanEmpty ?? true,
    symbols: tuiConfig.symbols,
    // 跨回合帧率上限：真实接线压到 10Hz（窗口内跨宏任务标脏合并到窗口末统一出帧），
    // 防事件洪峰时每回合全量排版过热；测试/演示不传（缺省 0=立即出帧）
    frameIntervalMs: 100,
    initialTheme: opts.initialTheme ?? resolvedThemes.active,
    messageGutter: opts.messageGutter,
  });
  app.setLogger(opts.logger ?? ((msg) => void msg));
  app.start();
  void renderer;
  // 返回 disposer：Cordis pause/unload 与信号/退出均经它释放 App/adapter
  // （adapter.dispose 释放当前活跃 handle，含 resume 后由 adapter 持有的新 handle）
  return () => app.dispose();
}

// ---------------------------------------------------------------------------
// cordis 插件入口
// ---------------------------------------------------------------------------

export const name = "tui";

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
  /** 用户块左缘/回复右缘对称留空（列数，默认 4；合法域 0..20，非法回退默认） */
  messageGutter?: number;
  /** 锚定工具引导（两阶段工具锁定-释放，移植自 dsh-anchored-standard）。
   *  全部 deepseek-* 模型生效（含 flash）；非 deepseek 模型与 false 时原样透传。默认 true。 */
  toolBootstrap?: boolean;
}

export interface TuiDisplayConfig {
  /** messageGutter 归一化结果（0..20，默认 4） */
  messageGutter: number;
}

/**
 * 归一化展示类配置：非法值（非有限数/越界）回退默认并发出一次性告警。
 * 纯函数，便于单测；在 apply() 配置边界集中处理，app 内不需要再判断合法性。
 */
export function normalizeTuiDisplayConfig(
  raw: Partial<Pick<DshTuiConfig, "messageGutter">> | undefined,
  warn: (msg: string) => void = (m) =>
    process.stderr.write("[tui] config warning: " + m + "\n"),
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
    messageGutter: num(raw?.messageGutter, 4, 0, 20, "messageGutter"),
  };
}

/** TUI 自有启动参数（宿主启动器把自有 flag 之后的内层参数经 `ctx.cmdlineArgs` 提供） */
export interface TuiStartupArgs {
  /** `--resume <id>` / `--resume=<id>`：启动即恢复指定会话 */
  resume?: string;
  /** `-c` / `--continue`：启动即加载当前目录下最近退出的会话 */
  continueLatest: boolean;
}

/**
 * 解析 TUI 自有启动参数（纯函数）。多插件共享同一内层参数列表——本函数**只读取、
 * 不消费**，未知参数一律忽略：
 *  - `--resume <id>` / `--resume=<id>`（缺值 / 空值视为未提供）；
 *  - `-c` / `--continue`；
 *  - 两者同时给出时 `--resume` 优先（更具体）。
 */
export function parseTuiStartupArgs(args: readonly string[]): TuiStartupArgs {
  let resume: string | undefined;
  let continueLatest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--resume") {
      const v = args[i + 1];
      if (v !== undefined && v !== "" && !v.startsWith("-")) {
        resume = v;
        i++;
      }
    } else if (a.startsWith("--resume=")) {
      const v = a.slice("--resume=".length);
      if (v !== "") resume = v;
    } else if (a === "-c" || a === "--continue") {
      continueLatest = true;
    }
  }
  return { ...(resume === undefined ? {} : { resume }), continueLatest };
}

/** 读取宿主内层参数（`ctx.cmdlineArgs.get()` 不可用/异常 → 空列表，启动不因此失败） */
function readCmdlineArgs(svc: { get?: () => unknown } | undefined): string[] {
  try {
    const v = svc?.get?.();
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** sessionQuery 等待上限（ms）：宿主服务随插件树**并发装载**（`-c` 决策早于 handle
 *  就绪，早读可能为空）；超时按「未挂载」处理，不阻断启动。 */
const SESSION_QUERY_WAIT_MS = 3_000;

/**
 * 有界等待宿主服务挂载：`read()` 读到即返回；超时（始终未挂载）→ undefined。
 * 依赖以参数注入（read + 超时），便于单测；用于「读点早于服务就绪」的启动决策
 * （`-c` 需先拿会话列表才能定 resume/新建）。
 */
export async function waitForHostService<T>(
  read: () => T | undefined,
  timeoutMs: number,
  stepMs = 50,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const svc = read();
    if (svc !== undefined) return svc;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * DSH 宿主加载本 bundle 时调用：创建/拉起 agent，组装真实链路并启动 TUI。
 * ctx 为 cordis Context(结构上满足 DshRuntime)，此处只做窄化。
 *
 * SAFETY: apply 由 cordis 注入完整 Context，本文件刻意不依赖 @deepseek-ai/*
 * 类型(保持零运行时依赖)，用 DshRuntime/DshAgentLike 结构面访问——所有消费
 * 字段(session.id、followup、agents.create、agentDefaultModel)与官方 dsh 公开
 * 契约一致，见docs/host/DSH-CTX-API.md §4 与 @deepseek-ai/dsh-agent-default-model。
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
    throw new Error("tui: ctx.agents.create 不可用(缺 dsh-agent-loop)");
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

  // 会话钩子（模型选择 + 锚定工具引导）：create/resume 共用同一 setup。
  // 注意：返回离谱值会被宿主当 commit 处理失败，故 setup 只 void 挂载。
  const makeSetup = (): ((agentCtx: unknown) => unknown) => (agentCtx) => {
    void installSessionModelSelection(
      agentCtx as DshRuntime,
      sessionModel,
      () => readDefaultSelection(defaultModelSvc),
    );
    // 锚定工具引导：全部 deepseek-* 模型触发锁定-释放；开关可配置关停
    void installToolBootstrap(agentCtx as DshRuntime, {
      enabled: config?.toolBootstrap ?? true,
    });
  };
  /** 新建会话（既有路径） */
  const createNewSession = async (): Promise<{
    agent: unknown;
    dispose(): Promise<void>;
  }> => {
    const { randomUUID } = await import("node:crypto");
    return agents.create({
      sessionId: "tui-" + randomUUID(),
      meta: { cwd: config?.cwd ?? process.cwd() },
      agentOptions: route,
      setup: makeSetup(),
    });
  };
  /** 恢复持久化会话（与 /session 切换同语义：agents.resume + 同一 setup/route） */
  const resumeSession = async (
    id: string,
  ): Promise<{ agent: unknown; dispose(): Promise<void> }> => {
    if (typeof agents.resume !== "function") {
      throw new Error("agents 未暴露 resume（宿主未配置会话持久化）");
    }
    return agents.resume({
      resumeSessionId: id,
      agentOptions: route,
      setup: makeSetup(),
    });
  };

  // --- 启动参数（BACKLOG TUI#2）：宿主经 ctx.cmdlineArgs 提供内层参数 -----------
  const cmdlineArgsSvc = (ctx as { get?: (name: string) => unknown }).get?.(
    "cmdlineArgs",
  ) as { get?: () => unknown } | undefined;
  const startup = parseTuiStartupArgs(readCmdlineArgs(cmdlineArgsSvc));
  // 会话查询服务读取闭包：服务随插件树**并发装载**，读点不同结果不同——
  // 此处只服务 `-c` 决策（需等待就绪）；adapter 选项一律在 handle 就绪后读
  // （「历史会话不可用」回归根因：apply 早期读到 undefined 后被复用给 adapter）。
  const readSessionQuery = (): SessionQueryLike | undefined =>
    (ctx as { get?: (name: string) => unknown }).get?.("sessionQuery") as
      SessionQueryLike | undefined;
  let handle: { agent: unknown; dispose(): Promise<void> };
  if (startup.resume !== undefined) {
    // --resume <id>：无效 id → stderr 提示并回落新建（条目原文）
    try {
      handle = await resumeSession(startup.resume);
    } catch (err) {
      process.stderr.write(
        `[tui] warn: --resume ${startup.resume} 失败（${String(err)}），回落新建会话\n`,
      );
      handle = await createNewSession();
    }
  } else if (startup.continueLatest) {
    // -c / --continue：当前目录下「最近退出」的会话（与 /continue 共用选择函数）；
    // 无匹配 → 静默新建（条目原文）
    let targetId: string | undefined;
    try {
      // 服务未就绪（provider 与 TUI 并发装载）→ 有界等待，避免「本可恢复」被当作
      // 「无匹配」而静默新建；始终未挂载/超时 → 按无匹配处理（条目原文）
      const sessionQuery = await waitForHostService(
        readSessionQuery,
        SESSION_QUERY_WAIT_MS,
      );
      const records = sessionQuery
        ? await listSessionRecords({ sessionQuery })
        : [];
      targetId = pickRecentSession(records, config?.cwd ?? process.cwd())?.id;
    } catch {
      targetId = undefined;
    }
    if (targetId === undefined) {
      handle = await createNewSession();
    } else {
      try {
        handle = await resumeSession(targetId);
      } catch (err) {
        process.stderr.write(
          `[tui] warn: --continue 恢复 ${targetId} 失败（${String(err)}），回落新建会话\n`,
        );
        handle = await createNewSession();
      }
    }
  } else {
    handle = await createNewSession();
  }

  const rawAgent = handle.agent as {
    session: { id: string };
    followup(m: DshUserMessageLike): void;
    /** DSH Agent.cancel(cause)：中断当前 turn/step（{kind:'user'} 为用户手动打断） */
    cancel?(cause: { kind: "user" }): void;
  };
  // SAFETY: agents.create 的返回契约(AgentHandle.agent)来自 @deepseek-ai/dsh-agent，
  // agent.session.id 与 agent.followup(UserMessage) 已获官方源码确认(docs/host/DSH-CTX-API.md)。
  const agentLike: DshAgentLike = {
    session: rawAgent.session,
    followup: (m) => rawAgent.followup(m),
  };

  if (!route.provider || !route.model) {
    process.stderr.write(
      "[tui] warn: model route 为空，agent 将无法发起请求(配置 provider/model 或环境默认)\n",
    );
  }

  // slash 命令注册表：官方 dsh-commands 服务(cordis 挂载，未在本插件 inject 声明，
  // 经 ctx.get 读取)。真实 agent 用于注册表作用域查找(runCommand 需要完整 Agent，
  // 而 app 层只有瘦 DshAgentLike)。结构面见 DshCommandLike(与 docs/host/DSH-CTX-API.md 契约一致)。
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
    // /new 新建会话沿用同一 meta（与上面 agents.create 一致，决定会话目录 slug）
    sessionMeta: { cwd: config?.cwd ?? process.cwd() },
    handleDispose: () => handle.dispose(),
    commands,
    llm: (ctx as { get?: (name: string) => unknown }).get?.("llm") as
      LlmLike | undefined,
    sessionModel,
    // 只读兜底：会话未切换时 /model 目录/状态显示与组装默认取宿主实时值(settings 热更新生效)
    defaultModel: defaultModelSvc,
    // 审批超时优先级（BACKLOG 3.3.7）：TUI 配置文件 > 宿主插件 config > 缺省 30s
    // （此处与插件装配不在同一作用域，故就地读取一次配置文件；启动期一次 IO，代价可忽略）
    approvalTimeoutMs:
      loadTuiConfig().approval?.timeoutMs ??
      config?.approvalTimeoutMs ??
      30_000,
    // 历史会话查询服务（ctx.get('sessionQuery')；缺失时 /session 提示不可用）。
    // 读点必须在此（handle 就绪之后）：provider 与 TUI 并发装载，apply 早期读为空
    sessionQuery: readSessionQuery(),
    // 会话存储服务（ctx.get('sessions')；live 会话读取原始事件需经它，缺失时降级 readSurface/readSession）
    sessions: (ctx as { get?: (name: string) => unknown }).get?.("sessions") as
      SessionStoreLike | undefined,
    // 权限预设服务（ctx.get('permissionPresets')，dsh-permission-presets；
    // 缺失时 /permission 提示不可用但适配层正常启动）
    permissionPresets: (ctx as { get?: (name: string) => unknown }).get?.(
      "permissionPresets",
    ) as PermissionPresetServiceLike | undefined,
    // agent 预设服务（ctx.get('agentPresets')，dsh-agent-presets；缺失时 /preset 提示不可用）
    agentPresets: (ctx as { get?: (name: string) => unknown }).get?.(
      "agentPresets",
    ) as AgentPresetsLike | undefined,
    // jobs 后台任务服务（ctx.get('jobs')，dsh-base 默认装配 dsh-jobs-local；缺失时 /jobs 提示不可用）
    jobs: (ctx as { get?: (name: string) => unknown }).get?.("jobs") as
      JobsLike | undefined,
    // 会话标题服务（ctx.get('sessionTitle')，dsh-session-title；缺失时 /rename 提示不可用）
    sessionTitle: (ctx as { get?: (name: string) => unknown }).get?.(
      "sessionTitle",
    ) as SessionTitleLike | undefined,
    // 技能目录服务（ctx.get('skills')，dsh-skill；缺失时 /skills 提示不可用）
    skills: (ctx as { get?: (name: string) => unknown }).get?.("skills") as
      SkillsLike | undefined,
    // 子代理服务（ctx.get('subagents')，dsh-subagent；缺失时 /agents 提示不可用）
    subagents: (ctx as { get?: (name: string) => unknown }).get?.(
      "subagents",
    ) as SubagentsLike | undefined,
    // 工具服务（ctx.get('tools')，dsh-tools；缺失时 /tools 提示不可用）
    tools: (ctx as { get?: (name: string) => unknown }).get?.("tools") as
      ToolsLike | undefined,
    // 设置服务（ctx.get('settings')，dsh-settings；缺失时 /settings 提示不可用）
    settings: (ctx as { get?: (name: string) => unknown }).get?.("settings") as
      SettingsLike | undefined,
    // 任务引擎只读查询面（ctx.get('taskEngine')，task-engine provide；缺失时 /task 提示不可用）
    taskEngine: (ctx as { get?: (name: string) => unknown }).get?.(
      "taskEngine",
    ) as TaskEngineLike | undefined,
    // 安全守卫只读查询面（ctx.get('guard')，security-guard provide；缺失时 /guard 提示不可用）
    guard: (ctx as { get?: (name: string) => unknown }).get?.("guard") as
      SecurityGuardLike | undefined,
    // 知识库只读查询面（ctx.get('knowledge')，knowledge-base provide；缺失时 /memory 提示不可用）
    knowledge: (ctx as { get?: (name: string) => unknown }).get?.(
      "knowledge",
    ) as KnowledgeServiceLike | undefined,
    // 循环只读查询面（ctx.get('metricLoop')，metric-loop provide；缺失时 /loop 提示不可用）
    metricLoop: (ctx as { get?: (name: string) => unknown }).get?.(
      "metricLoop",
    ) as MetricLoopLike | undefined,
    // 契约只读查询面（ctx.get('goalContract')；goal-contract 当前不 expose，
    // 缺失时 /contract 以内置同构回读兜底）
    goalContract: (ctx as { get?: (name: string) => unknown }).get?.(
      "goalContract",
    ) as GoalContractServiceLike | undefined,
    // 工作流引擎挂载探测（/workflows 面板数据源为 tool-workflow 事件流，引擎缺失 → 提示不可用）
    workflowEngine: (ctx as { get?: (name: string) => unknown }).get?.(
      "workflowEngine",
    ) as WorkflowEngineLike | undefined,
    // 搜索面（ctx.get('web')，dsh-web 统一多 provider 搜索 seam；缺失时 /search 提示不可用）
    web: (ctx as { get?: (name: string) => unknown }).get?.("web") as
      WebSearchLike | undefined,
  });

  // 展示类配置在配置边界一次性归一化（非法值告警并回退默认）
  const display = normalizeTuiDisplayConfig(config);
  const disposeApp = main({
    adapter,
    initialTheme:
      config?.theme === undefined ? undefined : normalizeThemeId(config.theme),
    logger: (msg) => process.stderr.write("[tui] " + msg + "\n"),
    messageGutter: display.messageGutter,
  });
  // Cordis 插件生命周期：pause/unload 时释放 App/adapter——
  // adapter.dispose 释放当前活跃 handle（含 resume 后由 adapter 持有的新 handle）。
  const ctxAny = ctx as { effect?: (fn: () => unknown) => unknown };
  ctxAny.effect?.(() => () => {
    disposeApp();
  });
  // 信号/退出兜底（renderer 的 SIGINT/TERM/Esc → close() 后进程退出）：
  // 同一清理路径，不再只释放初始 handle。
  process.once("exit", () => {
    disposeApp();
  });
}
