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
//   2. 组装入口 `main()`：renderer + app + adapter 的纯组装（由 apply() 调用；
//      bin/tui.js 的 mock demo 自行组装 App/renderer，不经此处）。

import { createRenderer, type Renderer } from "./renderer/index.ts";
import { normalizeThemeId, type ThemeId } from "./renderer/theme.ts";
import { resolveThemes } from "./renderer/theme-config.ts";
import { App } from "./app/index.ts";
import { installStderrBridge } from "./app/stderr-bridge.ts";
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
  shouldAutoKickoff,
  newSessionKickoffText,
  BOOTSTRAP_KICKOFF_TEXT,
  isDeepseekModel,
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
  type SessionChannelLike,
  type SymbolNormalizerLike,
  type RuleEngineLike,
} from "./app/adapter/dsh.ts";

/** 组装 renderer + app + adapter(纯组装，不设全局副作用)。 */
export function main(opts: {
  adapter: DshAdapter;
  logger?: (m: string) => void;
  /** 初始主题（默认 dark） */
  initialTheme?: ThemeId;
  /** 用户块左缘/回复右缘对称留空(列数，默认 4；由 apply 归一化，域 0..20) */
  messageGutter?: number;
  /** 测试注入：替代真实终端 renderer（缺省 createRenderer()） */
  renderer?: Renderer;
  /** 测试注入：替代真实状态查询（缺省 createProcessStatusQueries()） */
  statusQueries?: StatusQueries;
  /** 符号服务读取器（懒读，容忍插件装载顺序；symbol-normalizer 未挂载时返回 undefined） */
  getSymbols?: () => SymbolNormalizerLike | undefined;
  /** 会话通道读取器（懒读；session-channel 未挂载时返回 undefined → 状态栏不显示别名段，TUI#48） */
  getSessionChannel?: () => SessionChannelLike | undefined;
  /** rule-engine 服务读取器（懒读；未挂载 / 未实现 onNotice 时告警不经总线，走 stderr 兜底） */
  getRuleEngine?: () => RuleEngineLike | undefined;
  /** security-guard 服务读取器（懒读；`$` 模式执行前复查用）。未挂载 / 形状不符 / 抛错 →
   *  fail-open 照常执行 + 每种失效模式告警一次（BACKLOG「TUI `$` 模式执行面不经 guard」） */
  getGuard?: () => SecurityGuardLike | undefined;
  /** 启动自检 kickoff 正文（门控通过时传入，App 代替用户发出以完成锚定解锁）；
   *  不传 = 不发送（非 deepseek 模型 / toolBootstrap 关闭 / 会话已解锁 / 记录不可读）。
   *  2026-10-05 用户裁定**关掉 kickoff**：调用点已注释停用（本文件启动与 `/new` 两处），
   *  恒传 undefined；实现原样保留，恢复 = 取消那两处注释并删占位赋值。 */
  bootstrapKickoffText?: string;
  /** `/new` 的启动自检惰性门控（BACKLOG TUI#57）：每次新建会话切换完成后调用，返回正文
   *  则补发 kickoff；不传 / 返回 undefined = 不发。2026-10-05 起调用点恒返回 undefined（同关掉）。 */
  bootstrapKickoffForNewSession?: () => string | undefined;
  /** 重启交接文件路径（`process.env.DSH_RESTART_FILE`；非空 = 由处理退出码 75 的启动器启动，
   *  退出确认面板才提供「重启 dsh（保留会话）」；BACKLOG #51 / DESIGN「退出确认 ·「重启」方案」） */
  restartHandoffPath?: string;
  /** profile 目录（`ctx.get('profileContext').dir`）：实测宽度表落盘位置；缺省不落盘
   *  （不落盘时仍按需实测，只是不跨会话复用；见 layout/width-table.ts） */
  profileDir?: string;
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
    getSymbols: opts.getSymbols,
    getSessionChannel: opts.getSessionChannel,
    getRuleEngine: opts.getRuleEngine,
    getGuard: opts.getGuard,
    logger: opts.logger,
    // 跨回合帧率上限：真实接线压到 10Hz（窗口内跨宏任务标脏合并到窗口末统一出帧），
    // 防事件洪峰时每回合全量排版过热；测试/演示不传（缺省 0=立即出帧）
    frameIntervalMs: 100,
    initialTheme: opts.initialTheme ?? resolvedThemes.active,
    messageGutter: opts.messageGutter,
    bootstrapKickoffText: opts.bootstrapKickoffText,
    bootstrapKickoffForNewSession: opts.bootstrapKickoffForNewSession,
    restartHandoffPath: opts.restartHandoffPath,
    profileDir: opts.profileDir,
  });
  app.setLogger(opts.logger ?? ((msg) => void msg));
  // 运行期 stderr 桥（BACKLOG「rule-engine 的用户提示应显示在活动区」方案 A）：安装后
  // 运行期告警按行进入活动区（避免裸写落在输入区光标处）；启动前写入不受影响，dispose 时还原。
  const stderrBridge = installStderrBridge((line, tone) =>
    app.appendExternalLog(line, tone),
  );
  app.start();
  void renderer;
  // 返回 disposer：Cordis pause/unload 与信号/退出均经它释放 App/adapter
  // （adapter.dispose 释放当前活跃 handle，含 resume 后由 adapter 持有的新 handle）
  return () => {
    stderrBridge.restore();
    app.dispose();
  };
}

// ---------------------------------------------------------------------------
// cordis 插件入口
// ---------------------------------------------------------------------------

export const name = "tui";

export const inject = ["agents"];

export interface DshTuiConfig {
  /** 创建会话时的 cwd(默认 process.cwd()) */
  cwd?: string;
  /** 审批弹窗超时(ms，默认 30s；tui.config.json 的 approval.timeoutMs 优先) */
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
   *  全部 deepseek-* 模型生效（含 flash）；非 deepseek 模型与 false 时原样透传。默认 true。
   *  2026-10-05 用户裁定**不要锁定**：`main.ts` 的挂载已注释停用，本开关暂不生效；
   *  恢复 = 取消挂载注释。 */
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

/** 读取宿主 profile 目录（`ctx.get('profileContext').dir`）：
 *  实测宽度表落盘位置；服务缺失 / 取值异常 → undefined（App 侧不落盘，仍按需实测）。 */
function readProfileDir(ctx: unknown): string | undefined {
  try {
    const svc = (ctx as { get?: (name: string) => unknown }).get?.(
      "profileContext",
    ) as { dir?: unknown } | undefined;
    const dir = svc?.dir;
    return typeof dir === "string" && dir !== "" ? dir : undefined;
  } catch {
    return undefined;
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
    // 2026-10-05 用户裁定**不要锁定**：按「注释而非删除」停用挂载（实现原样保留）；
    // 恢复 = 取消下面注释（`toolBootstrap` 开关随挂载一并恢复生效）。
    // void installToolBootstrap(agentCtx as DshRuntime, {
    //   enabled: config?.toolBootstrap ?? true,
    // });
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
  /** TUI#40：本次启动是否**成功恢复**了持久化会话（--resume 命中 / -c 命中）→ 传 adapter */
  let startedFromResume = false;
  if (startup.resume !== undefined) {
    // --resume <id>：无效 id → stderr 提示并回落新建（条目原文）
    try {
      handle = await resumeSession(startup.resume);
      startedFromResume = true;
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
        startedFromResume = true;
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
    // TUI#40：启动即恢复（--resume / -c）→ App 启动时补一次历史折叠
    resumedAtLaunch: startedFromResume,
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
    // agent 预设服务（ctx.get('agentPresets')，dsh-agent-presets；缺失时目录同步降级）
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
    // 会话通道只读面（ctx.get('sessionChannel')）：状态列 Agents 块取会话别名，缺失/失败静默
    sessionChannel: (): SessionChannelLike | undefined =>
      (ctx as { get?: (name: string) => unknown }).get?.("sessionChannel") as
        SessionChannelLike | undefined,
    // 安全守卫只读查询面（ctx.get('guard')，security-guard provide；缺失时 /guard 提示不可用）
    // **惰读**（getter，与 `$` 复查的 getGuard / 上面 sessionChannel 同口径，BACKLOG「TUI 两处 guard
    // 读法不一致」）：apply 期快照会在「TUI 先于 security-guard 装载」时误报不可用。
    get guard(): SecurityGuardLike | undefined {
      return (ctx as { get?: (name: string) => unknown }).get?.("guard") as
        SecurityGuardLike | undefined;
    },
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

  // 符号服务（ctx.get('symbolNormalizer')，symbol-normalizer 插件 provide）：
  // 插件树并发装载，读点可能晚于 TUI 启动 → 传懒读函数，App 首次用到时再解析
  const getSymbolNormalizer = (): SymbolNormalizerLike | undefined =>
    (ctx as { get?: (name: string) => unknown }).get?.("symbolNormalizer") as
      SymbolNormalizerLike | undefined;

  // 会话通道服务（ctx.get('sessionChannel')，session-channel 插件 provide）：
  // 同上，懒读以容忍插件装载顺序；未挂载时状态栏不显示别名段（BACKLOG TUI#48）
  const getSessionChannel = (): SessionChannelLike | undefined =>
    (ctx as { get?: (name: string) => unknown }).get?.("sessionChannel") as
      SessionChannelLike | undefined;

  // rule-engine 服务（ctx.get('ruleEngine')，rule-engine 插件 provide）：同上懒读；
  // 未挂载 / 未实现 onNotice 时告警总线不接，插件侧仍走 stderr 兜底
  const getRuleEngine = (): RuleEngineLike | undefined =>
    (ctx as { get?: (name: string) => unknown }).get?.("ruleEngine") as
      RuleEngineLike | undefined;

  // security-guard 服务（ctx.get('guard')，security-guard 插件 provide）：同上懒读；
  // `$` 模式执行前复查一次（命中不执行、回执进输出区；未挂载 fail-open + 告警一次，
  // 见 local-shell.ts 的 makeShellGuardChecker 与 BACKLOG「TUI `$` 模式执行面不经 guard」）
  const getGuard = (): SecurityGuardLike | undefined =>
    (ctx as { get?: (name: string) => unknown }).get?.("guard") as
      SecurityGuardLike | undefined;

  // 展示类配置在配置边界一次性归一化（非法值告警并回退默认）
  const display = normalizeTuiDisplayConfig(config);
  // 启动自检门控（BACKLOG TUI「启动后自动触发首轮工具调用」）：开关未关 + 模型命中
  // deepseek + 会话未解锁 → 把正文交给 App，由其代替用户发出以完成锚定解锁；判据不可读
  // → 不发并 warn（与锚定 filter 的 fail-open 方向相反，见 shouldAutoKickoff）。
  // 2026-10-05 用户裁定**关掉 kickoff**：按「注释而非删除」停用（实现原样保留）；
  // 恢复 = 取消下面注释、删掉占位赋值。
  // const kickoffText = shouldAutoKickoff({
  //   enabled: config?.toolBootstrap ?? true,
  //   modelId: route.model ?? "",
  //   session: rawAgent.session,
  //   warn: (msg) => process.stderr.write("[tui] warn: " + msg + "\n"),
  // })
  //   ? BOOTSTRAP_KICKOFF_TEXT
  //   : undefined;
  const kickoffText: string | undefined = undefined;
  // `/new` 的启动自检门控（BACKLOG TUI#57）：惰性求值——每次新建会话时按**新会话将要使用的
  // 模型**判定。**不读 `sessionModel.current`**：那是按会话回填的值，而 `/new` 的判据必须在
  // `create()` 决议后的同一同步回合内求值（kickoff 须先于 rule-engine 的 session-start 注入
  // 入队），此刻 `restoreSessionState()` 尚未落定 → 读到的仍是**上一会话**的模型（求值窗口，
  // 跨模型切换时该发不发 / 不该发而发）。新会话模型 = 建会话时钉住的 route（`agentOptions`，
  // 见适配器 `newSession`）优先，否则宿主默认选择（种子）；判据不可读 → 不发。
  // 2026-10-05 用户裁定**关掉 kickoff**（同启动路径，注释停用、保留实现；恢复 = 取消注释）。
  // const kickoffForNewSession = (): string | undefined =>
  //   newSessionKickoffText({
  //     enabled: config?.toolBootstrap ?? true,
  //     pinnedModel: route.model,
  //     defaultModel: readDefaultSelection(defaultModelSvc)?.model,
  //   });
  const kickoffForNewSession = (): string | undefined => undefined;
  const disposeApp = main({
    adapter,
    bootstrapKickoffText: kickoffText,
    bootstrapKickoffForNewSession: kickoffForNewSession,
    // 启动器（如用户的 fffdsh 循环）经此变量声明「会处理退出码 75」（BACKLOG #51）
    restartHandoffPath: process.env.DSH_RESTART_FILE,
    // profile 目录（实测宽度表落盘位置，见 layout/width-table.ts）：宿主启动器提供
    // profileContext（`dsh --profile` 启动恒有）；独立 main() 启动时无此服务 → 不落盘
    profileDir: readProfileDir(ctx),
    initialTheme:
      config?.theme === undefined ? undefined : normalizeThemeId(config.theme),
    logger: (msg) => process.stderr.write("[tui] " + msg + "\n"),
    messageGutter: display.messageGutter,
    getSymbols: getSymbolNormalizer,
    getSessionChannel,
    getRuleEngine,
    getGuard,
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
