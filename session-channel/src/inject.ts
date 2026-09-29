// src/inject.ts — 把收到的消息注入目标会话（宿主 agent 面）。
//
// **时序红线**（rule-engine 已实证）：`session/event` 监听器运行在 `Session.append` 的同步
// 派发窗口内，此刻直接调用 `agent.followup()` 会撞重入保护（异常被宿主 logger 吞掉，现象是
// 「消息不落盘」）。因此统一 `setTimeout(…, 0)` 推迟一个宏任务后再投递。
//
// 消息构造硬要求（缺失会导致 append/resume 校验抛 `lacks an identified message`）：
// `id` 非空 string、`content` 为数组、`source.kind` 非空 string。

import { randomUUID } from "node:crypto";

/** 注入消息来源标识（生产者各自声明；TUI 按此识别并按用户块显示）。 */
export const SOURCE_KIND = "session-channel";

/** 注入正文前缀（与 `[AUTO]` / `[RULE]` 同口径：供人区分自动注入与真实输入）；来源紧跟其后：`[CHANNEL](来源) 正文`。 */
export const INJECTION_PREFIX = "[CHANNEL]";

/** 宿主 agent 的最小形态（结构面访问，不引宿主类型依赖）。 */
export interface AgentLike {
  /** agent 所属 session（`flush` 需要）。 */
  session?: unknown;
  /** 追加一条 user-role 消息到下一回合（同步 void）。 */
  followup?(message: unknown): void;
}

/** 宿主 ctx 的注入相关最小形态。 */
export interface InjectionHost {
  agents?: { get(id: string): AgentLike | undefined | null } | undefined;
  /** 注入后 flush 落盘（宿主 rc.2 面；缺失则跳过）。 */
  sessions?: { flush?(session: unknown): unknown } | undefined;
}

/**
 * 受保护地读宿主服务：`ctx.get(name)` 优先，直接属性读兜底并吞掉 cordis 抛错。
 * 真实 cordis ctx 上未 inject 的服务属性直读会抛
 * `cannot get property "x" without inject`——读取失败一律视为「服务不可用」。
 */
export function readService<T>(ctx: unknown, name: string): T | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  const c = ctx as Record<string, unknown>;
  // `get` 本身的读取也要保护：代理宿主上任何未 inject 的属性读都可能抛
  let getter: ((key: string) => unknown) | undefined;
  try {
    const g = c["get"];
    if (typeof g === "function") getter = g as (key: string) => unknown;
  } catch {
    getter = undefined;
  }
  if (getter !== undefined) {
    try {
      const svc = getter.call(c, name);
      if (svc !== undefined && svc !== null) return svc as T;
    } catch {
      /* 严格模式读取异常 → 尝试直接属性读 */
    }
  }
  try {
    const svc = c[name];
    return svc === undefined || svc === null ? undefined : (svc as T);
  } catch {
    return undefined;
  }
}

/**
 * 构造注入消息（user 角色 + `<prefix>(<来源>) ` 前缀 + 来源元数据）。
 * `from` 为发送方展示标签（调用方已按「别名优先、其次会话 id」解析）；空串显示「未知会话」。
 */
export function buildInjectionMessage(
  text: string,
  from: string,
  prefix: string = INJECTION_PREFIX,
): Record<string, unknown> {
  const origin = from === "" ? "未知会话" : from;
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: `${prefix}(${origin}) ${text}` }],
    source: { kind: SOURCE_KIND, summary: `session-channel 来自 ${origin}` },
  };
}

/**
 * 注入到目标会话：解析 agent → 推迟宏任务 → `followup`。
 * @returns false = 会话不在本进程/无 followup（调用方不写回执，消息留在流里可查）。
 */
export function injectUserMessage(
  host: InjectionHost,
  sessionId: string,
  message: Record<string, unknown>,
  onWarn?: (message: string) => void,
): boolean {
  const agent = host.agents?.get(sessionId);
  if (!agent || typeof agent.followup !== "function") return false;
  setTimeout(() => {
    try {
      agent.followup?.(message);
      // flush 落盘（与 rule-engine 同口径：followup 入 inbox 后需 flush 才写盘）
      host.sessions?.flush?.(agent.session);
    } catch (err) {
      onWarn?.(
        `注入被宿主拒绝：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, 0);
  return true;
}
