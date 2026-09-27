/**
 * 注入动作实现：把引擎给出的注入请求送达宿主 agent。
 *
 * **时序红线**：`session/event` 监听器运行在 `Session.append` 的同步派发窗口内，此刻调用
 * `agent.followup()` → `inbox.splice` → 再次 append 会撞重入保护（异常被宿主 logger.warn
 * 吞掉，现象是「消息不落盘」）。因此这里一律 `setTimeout(…, 0)` 推迟一个宏任务后再调用
 * 宿主 API——该路径有 TUI 符号纠正的真机实证（微任务路径未实证，本期不用）。
 *
 * 消息构造三项硬要求（缺失会导致 append/resume 校验抛 `lacks an identified message`）：
 * `id` 非空 string、`content` 为数组、`source.kind` 非空 string。
 *
 * 两条送达路径（`delivery`）：`followup`（缺省）= 独立新回合（`agent.followup`）；
 * `next-step` = 挂到最近 pre-step（`agent.inject`，不唤醒；宿主 rc.2+）。
 */

import { randomUUID } from "node:crypto";

import type { InjectionRequest, Injector } from "./types.ts";

/** 宿主 agent 的最小形态（结构面访问，不引入宿主类型依赖）。 */
export interface AgentLike {
  /** agent 所属 session（`flush` 需要）。 */
  session?: unknown;
  /** 追加一条 user-role 消息到下一回合（同步 void）。 */
  followup?(message: unknown): void;
  /** 把一条 user-role 消息挂到最近 pre-step（同步 void；宿主 rc.2+）。 */
  inject?(message: unknown): void;
}

/** 宿主 ctx 的注入相关最小形态。 */
export interface InjectionHost {
  agents?: { get(id: string): AgentLike | undefined | null } | undefined;
  sessions?: { flush(session: unknown): unknown } | undefined;
}

/** 注入消息来源标识（merge-extensible：官方无通用 'plugin' kind，生产者各自声明）。 */
export const SOURCE_KIND = "rule-engine";

/**
 * 构造注入消息。
 *
 * 带 `source.form:'notice'` + `summary` 元数据：宿主侧语义是「一次性事件的一行提示」。
 * dsh-toolset 的 TUI 目前未实现 `form` 分支，会按普通 user 消息块渲染（= 完全模拟用户
 * 输入）；将来 TUI 支持后自然变成一行提示，插件无需改动（BACKLOG #46）。
 */
export function buildInjectionMessage(
  text: string,
  summary: string,
): Record<string, unknown> {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: SOURCE_KIND, form: "notice", summary },
  };
}

/** 注入器构造参数。 */
export interface InjectorOptions {
  /** 推迟毫秒数，缺省 0（一个宏任务）；测试可显式传。 */
  delayMs?: number;
  /** 告警出口，缺省写 stderr。 */
  warn?: (message: string) => void;
}

/** 默认告警出口。 */
export function defaultWarn(message: string): void {
  process.stderr.write(`[rule-engine] warn: ${message}\n`);
}

/**
 * 真实注入器：推迟一个宏任务 → `agents.get(sessionId)` → 按 `delivery` 走
 * `followup(message)`（新回合）或 `inject(message)`（最近 pre-step）→
 * `sessions.flush(agent.session)` 确保落盘。会话非 live / 宿主面缺失 / 宿主抛错
 * 一律记 warning 后跳过（不向宿主抛，避免打断 run 收尾）。
 */
export function createAgentInjector(
  host: InjectionHost,
  options: InjectorOptions = {},
): Injector {
  const warn = options.warn ?? defaultWarn;
  const delayMs = options.delayMs ?? 0;
  return {
    inject(request: InjectionRequest): void {
      setTimeout(() => {
        deliver(host, request, warn);
      }, delayMs);
    },
  };
}

/** 单次送达（在推迟后的宏任务里执行）。 */
function deliver(
  host: InjectionHost,
  request: InjectionRequest,
  warn: (message: string) => void,
): void {
  const agents = host.agents;
  if (agents === undefined || typeof agents.get !== "function") {
    warn(`ctx.agents 不可用，来源 "${request.sourceId}" 的注入跳过`);
    return;
  }
  const agent = agents.get(request.sessionId);
  if (agent === undefined || agent === null) {
    warn(
      `会话 ${request.sessionId} 非 live，来源 "${request.sourceId}" 的注入跳过`,
    );
    return;
  }
  const message = buildInjectionMessage(request.text, request.summary);
  if (request.delivery === "next-step") {
    if (typeof agent.inject !== "function") {
      warn(
        `agent 不支持 inject（宿主 rc.2+ 才有），来源 "${request.sourceId}" 的 next-step 注入跳过`,
      );
      return;
    }
    try {
      agent.inject(message);
    } catch (err) {
      warn(`来源 "${request.sourceId}" inject 失败：${String(err)}`);
      return;
    }
  } else {
    if (typeof agent.followup !== "function") {
      warn(`agent 不支持 followup，来源 "${request.sourceId}" 的注入跳过`);
      return;
    }
    try {
      agent.followup(message);
    } catch (err) {
      warn(`来源 "${request.sourceId}" followup 失败：${String(err)}`);
      return;
    }
  }
  const sessions = host.sessions;
  if (sessions === undefined || typeof sessions.flush !== "function") {
    warn("ctx.sessions.flush 不可用，注入已追加但未等待落盘");
    return;
  }
  try {
    void Promise.resolve(sessions.flush(agent.session)).catch(
      (err: unknown) => {
        warn(`来源 "${request.sourceId}" flush 失败：${String(err)}`);
      },
    );
  } catch (err) {
    warn(`来源 "${request.sourceId}" flush 抛错：${String(err)}`);
  }
}
