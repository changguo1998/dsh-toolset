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
 * 三条送达路径（`delivery`，与宿主 `Agent` 方法同名）：
 * `followup`（缺省）= 独立新回合（`agent.followup`）；
 * `steer` = 挂到最近 pre-step 且唤醒（`agent.steer`：会话空闲时立刻开新回合，不等下一条输入）；
 * `inject` = 挂到最近 pre-step、不唤醒（`agent.inject`；宿主 rc.2+）。
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
  /** 同 `inject` 的 next-step 队列 + 唤醒（空闲时立刻开新回合；同步 void）。 */
  steer?(message: unknown): void;
}

/** 宿主 ctx 的注入相关最小形态。 */
export interface InjectionHost {
  agents?: { get(id: string): AgentLike | undefined | null } | undefined;
  sessions?: { flush(session: unknown): unknown } | undefined;
}

/** 注入消息来源标识（merge-extensible：官方无通用 'plugin' kind，生产者各自声明）。 */
export const SOURCE_KIND = "rule-engine";

/** 注入正文前缀：与 TUI 的启动自检 `[AUTO]` 同口径，用于区分「自动注入 / 真实用户输入」。 */
export const INJECTION_PREFIX = "[RULE] ";

/**
 * 构造注入消息。
 *
 * 不带 `source.form:'notice'`：TUI 按**用户输入块**显示（与启动自检 kickoff 同口径）、
 * 历史恢复后仍在；正文统一以 `[RULE] ` 开头，供人区分自动注入。`summary` 保留作元数据
 * （非 TUI 面 / 日志用）。注意：TUI 的实时路径不渲染非 notice 注入，由 adapter 识别
 * `source.kind` 后按 `rule-injection` 事件走用户行通道（BACKLOG TUI#49）。
 */
export function buildInjectionMessage(
  text: string,
  summary: string,
  summaries?: readonly string[],
): Record<string, unknown> {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: INJECTION_PREFIX + text }],
    source: {
      kind: SOURCE_KIND,
      summary,
      // 合并注入（多段）时保留各段摘要，供 `dedupeInRecord` 计数与展示
      ...(summaries !== undefined && summaries.length > 1
        ? { summaries: [...summaries] }
        : {}),
    },
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

/**
 * 会话句柄已关闭（子代理结束 / 会话被弃）属正常竞态：flush 失败静默降噪
 * （BACKLOG「子代理会话参与消费者评估 → 已关闭句柄 flush 告警」）。
 */
function isClosedHandleError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null;
  const text = `${typeof e?.name === "string" ? e.name : ""} ${
    typeof e?.message === "string" ? e.message : String(err)
  }`;
  return text.includes("SessionHandleClosed");
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
  const message = buildInjectionMessage(
    request.text,
    request.summary,
    request.summaries,
  );
  if (request.delivery === "followup") {
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
  } else {
    // inject / steer 共用宿主 next-step 队列，差别只在唤醒：steer 让空闲会话立刻开新回合
    const useSteer =
      request.delivery === "steer" && typeof agent.steer === "function";
    const send = useSteer ? agent.steer : agent.inject;
    if (typeof send !== "function") {
      warn(
        `agent 不支持 inject（宿主 rc.2+ 才有），来源 "${request.sourceId}" 的 ${request.delivery} 注入跳过`,
      );
      return;
    }
    if (request.delivery === "steer" && !useSteer) {
      warn(
        `agent 不支持 steer，来源 "${request.sourceId}" 的注入回退 inject（不唤醒）`,
      );
    }
    try {
      send.call(agent, message);
    } catch (err) {
      warn(
        `来源 "${request.sourceId}" ${request.delivery} 失败：${String(err)}`,
      );
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
        // 会话句柄已关闭属正常竞态（如子代理已结束）：静默；其它失败照常告警
        if (!isClosedHandleError(err)) {
          warn(`来源 "${request.sourceId}" flush 失败：${String(err)}`);
        }
      },
    );
  } catch (err) {
    warn(`来源 "${request.sourceId}" flush 抛错：${String(err)}`);
  }
}
