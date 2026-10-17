/**
 * 投递渠道（首期两条：文本 / 命令）。
 *
 * 口径（设计 §C② 与 §B）：
 * - **文本**：构造 user 消息（`content` 数组 + `source.kind = "background-daemon"`）→
 *   注入动作**推迟到宏任务**（避开 `session/event` 的同步派发窗口）→ `agent.followup`
 *   （排队、不打断当前回合、不调 `cancel`、不 `await whenIdle`）→ 以 `sessions.flush`
 *   作为 L2 确认；同会话同批到期的多条任务在**这里**拼成一条正文。
 * - **命令**：`commands.find` 命中才执行（未命中即 `command_not_found`，**不**降级成文本）,
 *   执行前过引擎侧安全复查（`guard_denied`；复查缺失 fail-open 并标 `guardSkipped`）,
 *   然后 `commands.execute`（立即语义，不排队）。
 *
 * 渠道只管「这一种投递怎么做」：不解析目标、不决定时点、不写任务表（那些是内核的事）。
 */

import { randomUUID } from "node:crypto";

import type { CommandChecker } from "./guard.ts";
import {
  SOURCE_KIND,
  type AgentLike,
  type ChannelResult,
  type DaemonChannel,
  type DaemonTask,
  type DeliveryRequest,
} from "./types.ts";

/** 注入正文前缀（与 `[RULE]` / `[CHANNEL]` 同口径：供人区分自动注入与真实输入）。 */
export const INJECTION_PREFIX = "[DAEMON] ";

/** 宿主会话 flush 面的最小结构子集。 */
export interface SessionsLike {
  flush?(session: unknown): unknown;
}

/** 宿主命令运行时的最小结构子集（`find` / `execute`）。 */
export interface CommandRuntimeLike {
  find?(agent: AgentLike, name: string): unknown;
  execute?(
    agent: AgentLike,
    line: string,
    submittedAttachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** 宿主命令执行结果的最小结构子集。 */
interface CommandExecutionLike {
  result?: { kind?: string; text?: string };
}

export interface TextChannelOptions {
  sessions?: SessionsLike | undefined;
  /** 宏任务推迟（缺省 `setTimeout(…, 0)`；测试注入同步实现）。 */
  defer?: (callback: () => void) => void;
  warn?: (message: string) => void;
  idFactory?: () => string;
}

/**
 * 构造一条投递消息（硬要求：`id` 非空、`content` 是数组、`source.kind` 非空——
 * 缺失会让宿主 append/resume 校验抛 `lacks an identified message`）。
 */
export function buildDeliverMessage(
  tasks: readonly DaemonTask[],
  idFactory: () => string = randomUUID,
): Record<string, unknown> {
  const body =
    tasks.length === 1
      ? (tasks[0]?.payload ?? "")
      : `${tasks.length} 条守护任务到点：\n${tasks
          .map((task) => `- ${task.payload}`)
          .join("\n")}`;
  const ids = tasks.map((task) => task.id).join(", ");
  return {
    id: idFactory(),
    role: "user",
    content: [{ type: "text", text: `${INJECTION_PREFIX}${body}` }],
    source: { kind: SOURCE_KIND, summary: `background-daemon 定时任务 ${ids}` },
  };
}

/** 文本渠道（排队语义 + flush 确认）。 */
export class TextChannel implements DaemonChannel {
  readonly mode = "deliver" as const;
  readonly #options: TextChannelOptions;

  constructor(options: TextChannelOptions = {}) {
    this.#options = options;
  }

  async deliver(request: DeliveryRequest): Promise<ChannelResult> {
    const agent = request.agent;
    if (typeof agent.followup !== "function") {
      return { ok: false, code: "no-active-agent", message: "agent 无 followup 面" };
    }
    const message = buildDeliverMessage(request.tasks, this.#options.idFactory);
    const deferred = await new Promise<{ ok: boolean; error?: string }>(
      (resolve) => {
        const inject = (): void => {
          try {
            // 目标 running 时 followup 天然排队：这里不等、不打断、不 cancel
            (agent.followup as (message: unknown) => void).call(agent, message);
            resolve({ ok: true });
          } catch (err) {
            resolve({ ok: false, error: String(err) });
          }
        };
        if (this.#options.defer === undefined) setTimeout(inject, 0);
        else this.#options.defer(inject);
      },
    );
    if (!deferred.ok) {
      return {
        ok: false,
        code: "error",
        message: `followup 被拒绝：${deferred.error ?? "未知错误"}`,
      };
    }
    const flush = this.#options.sessions?.flush;
    if (typeof flush !== "function") {
      // 没有 flush 面 = 只剩 L1（内存收件箱）; 仍算投出, 但明确标 volatile
      return {
        ok: true,
        durable: false,
        detail: "flush 面不可用（落盘未确认）",
      };
    }
    let confirmed: unknown;
    try {
      confirmed = await flush.call(this.#options.sessions, request.agent.session);
    } catch (err) {
      return {
        ok: false,
        code: "flush_failed",
        durable: false,
        message: `flush 抛错（消息已入收件箱、落盘未确认）：${String(err)}`,
      };
    }
    if (confirmed !== true) {
      return {
        ok: false,
        code: "flush_failed",
        durable: false,
        message:
          confirmed === false
            ? "flush 返回 false（消息已入收件箱、落盘未确认）"
            : "flush 未给出确认（消息已入收件箱、落盘未确认）",
      };
    }
    return {
      ok: true,
      durable: true,
      detail: `flush 确认（合并 ${request.tasks.length} 条）`,
    };
  }
}

/**
 * 解析命令行（`/name rest` 或 `name rest`）→ 规范化 slash 行 + 命令名。
 * 非法（空 / 名字不合法）返回 null。
 */
export function parseCommandLine(
  payload: string,
): { line: string; name: string } | null {
  const trimmed = payload.trim();
  if (trimmed === "") return null;
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const matched = /^([A-Za-z0-9][A-Za-z0-9_-]*)([\s\S]*)$/.exec(withoutSlash);
  if (matched === null) return null;
  const name = matched[1] ?? "";
  const rest = matched[2] ?? "";
  return { line: `/${name}${rest}`, name };
}

export interface CommandChannelOptions {
  commands?: CommandRuntimeLike | undefined;
  /** 引擎侧复查（缺省不复查——调用方应传 `makeCommandGuard(ctx)`）。 */
  guard?: CommandChecker;
}

/** 命令渠道（立即语义 + 引擎侧复查）。 */
export class CommandChannel implements DaemonChannel {
  readonly mode = "command" as const;
  readonly #options: CommandChannelOptions;

  constructor(options: CommandChannelOptions = {}) {
    this.#options = options;
  }

  async deliver(request: DeliveryRequest): Promise<ChannelResult> {
    let failed: ChannelResult | null = null;
    let guardSkipped = false;
    const details: string[] = [];
    for (const task of request.tasks) {
      const outcome = await this.#deliverOne(task, request);
      if (!outcome.ok) {
        failed = outcome;
        break;
      }
      guardSkipped = guardSkipped || outcome.guardSkipped === true;
      if (outcome.detail !== undefined && outcome.detail !== "") {
        details.push(outcome.detail);
      }
    }
    if (failed !== null) return failed;
    return {
      ok: true,
      ...(details.length === 0 ? {} : { detail: details.join("\n") }),
      ...(guardSkipped ? { guardSkipped: true } : {}),
    };
  }

  async #deliverOne(
    task: DaemonTask,
    request: DeliveryRequest,
  ): Promise<ChannelResult> {
    const parsed = parseCommandLine(task.payload);
    if (parsed === null) {
      return {
        ok: false,
        code: "error",
        message: `命令行非法：${task.payload.slice(0, 80)}`,
      };
    }
    const commands = this.#options.commands;
    if (
      commands === undefined ||
      typeof commands.find !== "function" ||
      typeof commands.execute !== "function"
    ) {
      return {
        ok: false,
        code: "error",
        message: "commands 服务不可用（命令类任务无法执行）",
      };
    }
    const found = commands.find(request.agent, parsed.name);
    if (found === undefined || found === null) {
      return {
        ok: false,
        code: "command_not_found",
        message: `未命中命令：/${parsed.name}（不降级成文本投递）`,
      };
    }
    const guardSkipped = this.#check(parsed.line);
    if (guardSkipped.receipt !== null) {
      return {
        ok: false,
        code: "guard_denied",
        message: guardSkipped.receipt,
      };
    }
    let execution: unknown;
    try {
      execution = await commands.execute(
        request.agent,
        parsed.line,
        [],
        request.signal,
      );
    } catch (err) {
      return { ok: false, code: "error", message: `命令执行抛错：${String(err)}` };
    }
    if (execution === undefined || execution === null) {
      return {
        ok: false,
        code: "error",
        message: `命令未被解析：${parsed.line}（语法或命令名未命中）`,
      };
    }
    const result = (execution as CommandExecutionLike).result;
    if (result?.kind === "error") {
      return {
        ok: false,
        code: "error",
        message: result.text ?? "命令执行失败",
      };
    }
    return {
      ok: true,
      ...(result?.text === undefined ? {} : { detail: result.text }),
      ...(guardSkipped.skipped ? { guardSkipped: true } : {}),
    };
  }

  /** 引擎侧复查：返回回执即拦截；`skipped` 透传给记账（fail-open 可见）。 */
  #check(line: string): { receipt: string | null; skipped: boolean } {
    const guard = this.#options.guard;
    if (guard === undefined) return { receipt: null, skipped: false };
    return guard(line);
  }
}
