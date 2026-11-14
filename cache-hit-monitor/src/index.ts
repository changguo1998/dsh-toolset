/**
 * cache-hit-monitor 插件入口（DSH bundle 接入面）。
 *
 * 角色：对模型调用的缓存命中率做监控——请求前按「上次与本次请求上下文的比较」预估
 * 本步可命中率（前缀重叠度近似）, 收到返回后对比实际命中率（`assistant/message.usage
 * .cacheReadTokens`）, 偏差超阈值判定缓存失效。判定靠对比结果, 不靠时间; 偏差大的
 * 典型成因是服务商侧缓存失效（含长时间未命中导致缓存过期）。
 *
 * 数据面（宿主 0.2.2-rc.1）：
 * - 请求前时机 `agent/pre-step`：载荷只带本步新认领消息, 不含完整上下文; 完整上下文
 *   需自行 `ctx.sessions.get(id).deriveMessages()` 取快照（权威重建, 宿主发请求时用的
 *   就是它）。本插件是**只读订阅**（waterfall, 返回 PreStepDecision, 有 prepend 注入
 *   语义）——只取快照、不返回任何注入字段, 不干扰宿主决策。
 * - 实际命中率：`session/event` 的 `assistant/message.usage.cacheReadTokens`。
 * - 口径：预估 = 重叠长度 / 本次总输入; 实际 = cacheRead / (input + cacheRead)
 *   （与 /stats 同基准; 分子分母口径如有真机偏差按追踪文档决策 12 备忘修订）。
 *
 * 服务面：`cacheHitMonitor.summary(sessionId)` → TUI 状态行 cache 段按状态着色
 * （绿 = 正常 / 红 = 缓存失效告警 / 黄 = 首次无基线, 命中率按 0）。
 */

export const name = "cache-hit-monitor";

import type { MonitorState } from "./monitor.ts";
import { dropState, endStep, recordSnapshot } from "./monitor.ts";

/** 硬依赖: 无（sessions / on / provide 均为宿主基座, 由 apply 运行时取用）。 */
export const inject: string[] = [];

/** 对外只读服务面: `cacheHitMonitor`（TUI 状态行懒读, 加载顺序由懒读兜住）。 */
export const provide = ["cacheHitMonitor"];

/** 插件配置（类型声明, 宿主不校验; 缺省见 resolveConfig）。 */
export interface Config {
  /** 是否开启采集与判定（缺省 true）。 */
  enabled?: boolean;
  /** 预估与实际命中率偏差阈值, 超阈值判缓存失效（缺省 0.3）。 */
  tolerance?: number;
  /** 可选「只盯第一步」: 开启时只在第一步更新判定（缺省 false = 全回合实时）。 */
  firstStepOnly?: boolean;
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  tolerance: number;
  firstStepOnly: boolean;
}

/** 配置归一化（非法/未填值回退缺省）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const tolerance =
    typeof config?.tolerance === "number" &&
    Number.isFinite(config.tolerance) &&
    config.tolerance >= 0 &&
    config.tolerance <= 1
      ? config.tolerance
      : 0.3;
  return {
    enabled: config?.enabled !== false,
    tolerance,
    firstStepOnly: config?.firstStepOnly === true,
  };
}

/** 插件上下文的最小形状（宿主注入面的子集, 运行时经 ctx 提供）。 */
export interface PluginContext {
  on?(event: string, handler: (...args: unknown[]) => unknown): () => void;
  provide?(name: string, value: unknown): void;
  sessions?: {
    get(id: string): { deriveMessages(): unknown[] } | undefined;
  };
  logger?: { warn(message: string): void };
}

/** `agent/pre-step` 载荷（宿主 0.2.2-rc.1; agent 由事件面注入）。 */
export interface PreStepPayload {
  agent?: {
    sessionId: string;
    session: { deriveMessages(): unknown[] };
  };
  messages: unknown[];
  turn?: number;
  step?: number;
}

/** `agent/pre-step` 的 `next`（宿主 waterfall 传入; 原样透传即不干扰决策）。 */
export type PreStepNext = () => Promise<unknown>;

/** `session/event` 载荷里的 usage 事件（`assistant/message` 附带; 与 TUI 提取同源）。 */
export interface UsageEventLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/** `session/event` 载荷（结构面, 只取 assistant/message 的 usage）。 */
export interface SessionEventLike {
  type?: string;
  data?: {
    usage?: UsageEventLike;
  };
}

/** 服务面摘要：TUI 状态行 cache 段据此着色。 */
export interface CacheHitMonitorService {
  /** 当前判定状态（normal / stale / first; 无数据 = undefined → 渲染层保持 `—` 占位）。 */
  summary(sessionId: string): {
    state: "normal" | "stale" | "first" | undefined;
    /** 最近一步的实际命中率（无 = undefined）。 */
    lastHitRate: number | undefined;
    /** 本回合从开始到当前的运行最低实际命中率（无真实数据 = undefined）。 */
    runMinHitRate: number | undefined;
    /** 配置的偏差容差阈值。 */
    tolerance: number;
  };
}

/** per-session 监控状态（哨兵: 会话销毁清理）。 */
export interface SessionCaches {
  states: Map<string, MonitorState>;
}

/** 挂载: 订阅采集/判定事件并暴露服务面（A1 骨架, 采集与判定在 A2–A4 补齐）。 */
export function apply(ctx: unknown, config?: Config): () => void {
  const c = (ctx ?? {}) as PluginContext;
  const resolved = resolveConfig(config);
  const disposers: Array<() => void> = [];
  const warn = (message: string): void => {
    if (typeof c.logger?.warn === "function") {
      c.logger.warn(`[cache-hit-monitor] ${message}`);
      return;
    }
    process.stderr.write(`[cache-hit-monitor] warn: ${message}\n`);
  };

  if (!resolved.enabled) {
    warn("enabled=false: 采集与判定关闭");
    return () => {
      for (const off of disposers) off();
    };
  }

  // per-session 监控状态：上次请求前快照等。会话销毁时清理, 防止状态泄漏。
  const states = new Map<string, MonitorState>();

  // A2: agent/pre-step 只读订阅——取请求前完整上下文快照, 原样透传决策。
  // 验证语义（决策 4 备忘）: 本事件是 waterfall（返回 PreStepDecision, 有 prepend
  // 注入语义）；只读监听应 `return next()` 把决策透传, 不返回任何注入字段。
  if (typeof c.on === "function") {
    const off = c.on(
      "agent/pre-step",
      async (payload: unknown, next: unknown) => {
        const p = (payload ?? {}) as PreStepPayload;
        const agent = p.agent;
        const fallback = typeof next === "function" ? next : undefined;
        if (agent && typeof agent.session?.deriveMessages === "function") {
          try {
            const snapshot = agent.session.deriveMessages();
            recordSnapshot(states, agent.sessionId, snapshot);
          } catch (error) {
            warn(`取请求前上下文快照失败（跳过本步预估）: ${String(error)}`);
          }
        }
        if (fallback) return await fallback();
        return { kind: "enter", messages: p.messages };
      },
    );
    disposers.push(off);
  } else {
    warn("ctx.on 不可用, 缓存命中率监控不会订阅");
  }

  // A4: session/event——assistant/message.usage 到达时结算一步判定。
  // 载荷与 TUI 提取同源（`data.usage.{cacheReadTokens,inputTokens}`）。
  if (typeof c.on === "function") {
    const off = c.on("session/event", (session: unknown, raw: unknown) => {
      const sessionId = (session as { id?: string } | null)?.id;
      if (typeof sessionId !== "string" || sessionId === "") return;
      const event = (raw ?? {}) as SessionEventLike;
      if (event.type !== "assistant/message") return;
      const usage = event.data?.usage;
      if (usage === undefined) return; // 无 usage: 渲染层保持 `—` 占位（决策 11）
      const state = states.get(sessionId);
      if (state === undefined) return; // 没有 pre-step 快照的会话不算（防御）
      try {
        endStep(state, {
          tolerance: resolved.tolerance,
          firstStepOnly: resolved.firstStepOnly,
          input: usage.inputTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
        });
      } catch (error) {
        warn(`结算一步缓存判定失败: ${String(error)}`);
      }
    });
    disposers.push(off);
  }

  // 服务面（决策 8）: 只读, TUI 状态行每 tick 懒读, 加载顺序由懒读兜住。
  if (typeof c.provide === "function") {
    try {
      const service: CacheHitMonitorService = {
        summary(sessionId: string) {
          const state = states.get(sessionId);
          if (state === undefined || state.lastOutcome === undefined) {
            return {
              state: undefined,
              lastHitRate: undefined,
              runMinHitRate: state?.runMinActual,
              tolerance: resolved.tolerance,
            };
          }
          return {
            state: state.lastOutcome.state,
            lastHitRate: state.lastOutcome.actual,
            runMinHitRate: state.runMinActual,
            tolerance: resolved.tolerance,
          };
        },
      };
      c.provide("cacheHitMonitor", service);
    } catch (error) {
      warn(`服务面 cacheHitMonitor 暴露失败（忽略）: ${String(error)}`);
    }
  } else {
    warn("ctx.provide 不可用, TUI 读不到缓存命中状态");
  }

  // 会话销毁：清理该会话的监控状态, 避免跨会话残留。
  if (typeof c.on === "function") {
    const off = c.on("session/disposed", (session: unknown) => {
      const id = (session as { id?: string } | null)?.id;
      if (id !== undefined) dropState(states, id);
    });
    disposers.push(off);
  }

  return () => {
    for (const off of disposers) off();
  };
}
