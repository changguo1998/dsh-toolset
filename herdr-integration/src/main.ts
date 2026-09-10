// src/main.ts — dsh-herdr 集成插件入口（bundle 形态，零运行时依赖）
//
// 职责：
//   1. 环境变量握手（HERDR_ENV / HERDR_SOCKET_PATH / HERDR_PANE_ID），未启用即空转。
//   2. 订阅 agent/status：根 agent 的 idle/running 转移 → herdr 的 idle/working。
//   3. blocked 事件桥：观察型 waterfall 监听 approval/request、user-questions/request——
//      pending 期间上报 blocked（等待审批 / 等待用户），next() 沉降后解除；监听者
//      不认领请求，不影响真实答案者（如 dsh-tui）。注意：观察者必须先于答案者注册，
//      profile bundles 顺序应将本 bundle 排在 dsh-tui 之前（见 cordis.patch.yml 注释）。
//   4. 根 agent 出现/会话切换时上报 pane.report_agent_session。
//
// 契约对齐 DSH-CTX-API.md（dsh 0.1.2-rc.1）：
//   - agent/status({agent, status})，AgentStatus = 'idle' | 'running'（agent 层事件）；
//   - approval/request(req, next)、user-questions/request(req, next) 均为 agent 作用域
//     waterfall；根 ctx（unscoped）全局放行，可收所有 agent 的请求；
//   - ctx.get('agents').roots()：根 agent 注册表（owner === undefined）。

import { HerdrClient, readHerdrEnv } from "./herdr.ts";
import type {
  AgentState,
  HerdrClientOptions,
  HerdrSender,
  SessionRef,
} from "./herdr.ts";
import { BlockTracker, desiredState } from "./state.ts";

/** 根 agent 结构面（只消费 session.id 与 status）。 */
export interface RootAgentLike {
  session?: { id?: string };
  status?: string;
}

/** cordis Context 结构面（窄化访问，不引入 @deepseek-ai/* 类型）。 */
export interface PluginCtxLike {
  on(
    event: string,
    listener: (...args: unknown[]) => unknown,
  ): (() => boolean) | void;
  get?(name: string): unknown;
  effect?(fn: () => unknown): unknown;
}

/** 插件配置（可选覆盖，缺省对齐 pi 原生行为）。 */
export interface HerdrIntegrationConfig {
  /** 面板来源标识（默认 "herdr:dsh"） */
  source?: string;
  /** agent 标识（默认 "dsh"） */
  agent?: string;
  /** 首档发送尝试的等待响应超时 ms（默认 500，与 pi 原生一致） */
  attemptTimeoutMs?: number;
}

/** 测试注入面。 */
export interface HerdrPluginDeps {
  /** 替代真实 unix socket 发送器（单测用记录器） */
  sender?: HerdrSender;
  /** 替代环境变量读取（单测用） */
  readHerdrEnv?: (env: NodeJS.ProcessEnv) => HerdrClientOptions | undefined;
  /** 替代 agents 注册表读取（单测用） */
  readRoots?: () => RootAgentLike[];
}

export interface HerdrPluginHandle {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export const name = "@dsh-toolset/herdr-integration";

export const inject = ["agents"];

/**
 * cordis 加载本 bundle 时调用。未在 herdr 面板内（握手环境变量不全）时静默空转，
 * 不产生任何副作用。
 */
export async function apply(
  ctx: unknown,
  config: HerdrIntegrationConfig = {},
): Promise<void> {
  const plugin = createHerdrPlugin(ctx as PluginCtxLike, config);
  if (!plugin) return;
  const ctxAny = ctx as { effect?: (fn: () => unknown) => unknown };
  ctxAny.effect?.(() => () => {
    plugin.dispose();
  });
}

/**
 * 组装插件（含状态跟踪与事件订阅）。环境握手未启用或发送器不可用时返回 undefined。
 * deps 仅供单测注入；生产路径全部使用真实实现。
 */
export function createHerdrPlugin(
  ctx: PluginCtxLike,
  config: HerdrIntegrationConfig = {},
  deps: HerdrPluginDeps = {},
): HerdrPluginHandle | undefined {
  const readEnv = deps.readHerdrEnv ?? readHerdrEnv;
  const clientOptions = readEnv(process.env);
  if (!clientOptions) return undefined;

  const sender: HerdrSender =
    deps.sender ??
    new HerdrClient({
      ...clientOptions,
      source: config.source ?? clientOptions.source,
      agent: config.agent ?? clientOptions.agent,
      attemptTimeoutMs:
        config.attemptTimeoutMs ?? clientOptions.attemptTimeoutMs,
    });

  const readRoots: () => RootAgentLike[] =
    deps.readRoots ??
    (() => {
      const agents = ctx.get?.("agents") as { roots?(): unknown } | undefined;
      const roots = agents?.roots?.();
      return Array.isArray(roots) ? (roots as unknown as RootAgentLike[]) : [];
    });

  // ---- 状态跟踪（内存态） ----
  const blocks = new BlockTracker();
  let agentActive = false;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let currentSessionRef: SessionRef | undefined;

  /** 变化检测后上报（force 跳过同态判断，用于启动期）；发信失败静默忽略。 */
  const publish = (force: boolean): void => {
    const next = desiredState(agentActive, blocks.blocked, blocks.message);
    if (!force && next.state === lastState && next.message === lastMessage) {
      return;
    }
    lastState = next.state;
    lastMessage = next.message;
    void sender.reportState(next.state, next.message);
  };

  /** 首次见到的根 agent 会话即上报；会话 id 变化（如 resume 切换）再次上报。 */
  const adoptSession = (ref: SessionRef | undefined): void => {
    if (!ref?.id) return;
    if (currentSessionRef?.id === ref.id) return;
    const first = currentSessionRef === undefined;
    currentSessionRef = ref;
    sender.setSessionRef(ref);
    void sender.reportSession(ref, first ? "startup" : undefined);
  };

  const refFromAgent = (agent: unknown): SessionRef | undefined => {
    const session = (agent as { session?: { id?: string } } | undefined)
      ?.session;
    return session?.id ? { id: session.id } : undefined;
  };

  // ---- 事件订阅 ----

  /** agent/status：根 agent 转移 → 会话上报 + 活跃度刷新。 */
  const handleStatus = (payload: unknown): void => {
    const p = payload as { agent?: unknown; status?: string } | undefined;
    if (!p) return;
    const roots = readRoots();
    const ref = refFromAgent(p.agent);
    // 只跟踪根 agent（与 pi 原生 rootSession 语义一致；子 agent 不翻转面板状态）
    if (ref?.id && roots.some((agent) => agent.session?.id === ref.id)) {
      adoptSession(ref);
    }
    // 活跃度取根 agent 全集实时状态（顺带覆盖 dispose 前最后转移可能丢失的边界）
    const running = roots.some((agent) => agent.status === "running");
    if (running !== agentActive) {
      agentActive = running;
      publish(false);
    }
  };

  /**
   * 观察型 waterfall 阻塞桥：begin → next() → end。
   * await 保证 finally 在请求沉降（answer/reject）后才解除阻塞。
   */
  const observeBlocked =
    (key: string, label: string) =>
    async (
      _request: unknown,
      next: () => Promise<unknown>,
    ): Promise<unknown> => {
      blocks.begin(key, label);
      publish(false);
      try {
        return await next();
      } finally {
        blocks.end(key);
        publish(false);
      }
    };

  const unbinds: Array<(() => boolean) | void> = [];
  unbinds.push(ctx.on("agent/status", handleStatus));
  unbinds.push(
    ctx.on(
      "approval/request",
      observeBlocked("approval", "waiting for approval") as (
        ...args: unknown[]
      ) => unknown,
    ),
  );
  unbinds.push(
    ctx.on(
      "user-questions/request",
      observeBlocked("ask-user", "waiting for user") as (
        ...args: unknown[]
      ) => unknown,
    ),
  );

  // ---- 启动期同步：已存在的根 agent（可能先于本插件创建） ----
  const startupRoots = readRoots();
  for (const agent of startupRoots) {
    adoptSession(refFromAgent(agent));
  }
  agentActive = startupRoots.some((agent) => agent.status === "running");
  publish(true);

  return {
    dispose(): void {
      for (const unbind of unbinds) {
        if (typeof unbind === "function") {
          unbind();
        }
      }
    },
  };
}
