/**
 * pin-note 插件入口（DSH bundle 接入面）。
 *
 * 角色：**跨压缩上下文保持** —— 模型经 `pin_note` 把要点登记到本会话记忆库（memory-base 的
 * `pin` 分类, 会话层）；本插件在 `agent/pre-step` 每步把「保持项」折叠进 `decision.messages`，
 * 并在 `agent.inbox` 只留一条（照宿主 `agent-instructions` 的先例：payload 相同不重复插入，
 * 内容变化后替换旧的一条）。压缩把消息移出上下文后, 下一步立刻补回 —— 这就是「跨压缩在场」。
 *
 * 去重：注入前先读当前上下文（`session.deriveMessages()`, 老宿主回退到投影事件比对），
 * 同一段正文已在上下文里就不再注入；长回合因此只出现一段。比对按正文相等, 不看 source / id。
 *
 * 工具面：`pin_note` / `note_list` / `note_remove`（memory-base 不注册模型侧写工具, 写通道由本包补）。
 *
 * 降级：`ctx.memory` 不可用（或 `registerKind` 抛错）时只向 stderr / logger 告警, 不注册工具、
 * 不订阅注入, 不让宿主启动失败。
 */

import type { MemoryFaceLike } from "./store.ts";
import { DEFAULT_MAX_NOTES, PinStore } from "./store.ts";
import {
  hasText,
  isPinMessage,
  messageText,
  pinMessage,
  samePinPayload,
  type PinMessageLike,
} from "./inject.ts";
import { noteTools, type ToolDef } from "./tools.ts";

export const name = "pin-note";

/** 硬依赖：记忆库（写句柄）与工具注册面。 */
export const inject = ["memory", "tools"];

/** 对外只读服务面: pinNotes.summary(sessionId)（TUI 状态列用）。 */
export const provide = ["pinNotes"];

/** 服务面摘要: 条数 / 合计字数 / 标题。 */
export interface PinSummary {
  count: number;
  chars: number;
  titles: string[];
}

/** 插件配置（类型声明，宿主不校验；缺省见 resolveConfig）。 */
export interface Config {
  /** 是否开启（缺省 `true`；显式 `false` 时不注入, 工具仍注册）。 */
  enabled?: boolean;
  /** 一次读回的最大条数（缺省 50）。 */
  maxNotes?: number;
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  maxNotes: number;
}

/** 归一化配置（非法值回退缺省，不抛错）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const maxNotes =
    typeof config?.maxNotes === "number" &&
    Number.isFinite(config.maxNotes) &&
    config.maxNotes > 0
      ? Math.floor(config.maxNotes)
      : DEFAULT_MAX_NOTES;
  return { enabled: config?.enabled !== false, maxNotes };
}

/** 宿主 inbox 的结构面（`nextStep` 缺省时按空处理）。 */
interface InboxLike {
  nextStep?: readonly PinMessageLike[];
  remove?(id: string): void;
  prepend?(where: "next-step", message: PinMessageLike): void;
  replace?(id: string, message: PinMessageLike): void;
}

/** 宿主 session 的结构面（`deriveMessages` 是当前读面, `eventAt` 只在老宿主上兜底）。 */
interface SessionLike {
  id?: string;
  surface?: { nodes: readonly number[] };
  /** 当前上下文派生的消息（宿主推荐读面）。 */
  deriveMessages?: () => readonly unknown[];
  eventAt?: (seq: number) => { type: string; data?: unknown } | undefined;
}

/** 宿主 agent 的结构面。 */
interface AgentLike {
  session?: SessionLike;
  inbox?: InboxLike;
}

/** `agent/pre-step` 的载荷结构面。 */
interface PreStepPayloadLike {
  agent?: AgentLike;
  messages?: readonly PinMessageLike[];
}

/** `PreStepDecision` 的结构子集。 */
interface DecisionLike {
  kind?: string;
  messages?: PinMessageLike[];
}

/** 插件上下文的结构化面。 */
interface PluginContext {
  memory?: MemoryFaceLike;
  tools?: { register(def: unknown): unknown };
  provide?(name: string, value: unknown): unknown;
  on?(event: string, handler: (...args: unknown[]) => unknown): () => void;
  logger?: { warn?: (message: string) => void };
}

/** 该 payload 是否已在上下文中（先按正文读 `deriveMessages`, 退化到投影事件比对）。 */
function alreadyInContext(agent: AgentLike, desired: PinMessageLike): boolean {
  const session = agent.session;
  const text = messageText(desired);
  if (text !== undefined && typeof session?.deriveMessages === "function") {
    try {
      if (hasText(session.deriveMessages(), text)) return true;
    } catch {
      /* 读面异常：落到投影比对 */
    }
  }
  return alreadyInSurface(agent, desired);
}

/** 该 payload 是否已在会话投影里（`eventAt` 老宿主回退路径）。 */
function alreadyInSurface(agent: AgentLike, desired: PinMessageLike): boolean {
  const session = agent.session;
  if (session?.surface === undefined || typeof session.eventAt !== "function")
    return false;
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== "user/message") continue;
    const data = event.data as PinMessageLike | undefined;
    if (data !== undefined && samePinPayload(data, desired)) return true;
  }
  return false;
}

/**
 * 让 inbox 里本插件的待消费消息收敛成一条（或无）。
 * 口径同 `agent-instructions`：已在本步 claim 的批次或会话投影里 → 全部清掉；同 payload 复用一条；
 * 否则替换第一条、删掉其余。
 */
function syncInbox(
  agent: AgentLike,
  claimed: readonly PinMessageLike[],
  desired: PinMessageLike | undefined,
): void {
  const inbox = agent.inbox;
  if (inbox === undefined) return;
  const pending = (inbox.nextStep ?? []).filter(isPinMessage);
  if (desired === undefined) {
    for (const message of pending) inbox.remove?.(message.id);
    return;
  }
  const supplied =
    claimed.some((message) => samePinPayload(message, desired)) ||
    alreadyInContext(agent, desired);
  if (supplied) {
    for (const message of pending) inbox.remove?.(message.id);
    return;
  }
  const reusable = pending.find((message) => samePinPayload(message, desired));
  if (reusable !== undefined) {
    for (const message of pending) {
      if (message !== reusable) inbox.remove?.(message.id);
    }
    return;
  }
  const replaced = pending[0];
  if (replaced === undefined) inbox.prepend?.("next-step", desired);
  else inbox.replace?.(replaced.id, desired);
  for (const message of pending.slice(1)) inbox.remove?.(message.id);
}

/** 把 desired 插在最后一条本步 claim 的消息之后（找不到就插到最前）。 */
function foldMessages(
  messages: readonly PinMessageLike[],
  claimed: readonly PinMessageLike[],
  desired: PinMessageLike,
): PinMessageLike[] {
  let lastClaimed = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (claimed.includes(messages[i]!)) lastClaimed = i;
  }
  const at = lastClaimed + 1;
  return [...messages.slice(0, at), desired, ...messages.slice(at)];
}

/**
 * 挂载：注册三个工具、订阅 `agent/pre-step`。
 * 返回 dispose（注销订阅；工具注册面由宿主随插件卸载回收）。
 */
export function apply(ctx: unknown, config?: Config): () => void {
  const c = (ctx ?? {}) as PluginContext;
  const warn = (message: string): void => {
    if (typeof c.logger?.warn === "function") {
      c.logger.warn(`[pin-note] ${message}`);
      return;
    }
    process.stderr.write(`[pin-note] warn: ${message}\n`);
  };
  const resolved = resolveConfig(config);
  const memory = c.memory;
  if (memory === undefined || typeof memory.registerKind !== "function") {
    warn("ctx.memory 不可用，保持项不会注入（请检查 memory-base 是否挂载）");
    return () => {};
  }
  const store = new PinStore(memory, { maxNotes: resolved.maxNotes });
  if (!store.available) {
    warn(
      `memory-base 分类 pin 注册失败（${store.unavailableReason ?? "原因未知"}），保持项不会注入`,
    );
    return () => {};
  }

  // 只读服务面：TUI 状态列每 tick 懒读（会话层无法从全局面列举, 只能由本包给摘要）
  if (typeof c.provide === "function") {
    try {
      c.provide("pinNotes", {
        summary: async (sessionId: string): Promise<PinSummary> => {
          const records = await store.list(sessionId);
          return {
            count: records.length,
            chars: records.reduce(
              (sum, record) => sum + record.content.length,
              0,
            ),
            titles: records.map((record) => record.title),
          };
        },
      });
    } catch (error) {
      warn(`服务面 pinNotes 暴露失败（忽略）：${String(error)}`);
    }
  }

  if (typeof c.tools?.register === "function") {
    const tools: ToolDef[] = noteTools(store);
    for (const tool of tools) {
      try {
        c.tools.register(tool);
      } catch (error) {
        warn(`工具 ${tool.name} 注册失败：${String(error)}`);
      }
    }
  } else {
    warn("ctx.tools 不可用，pin_note / note_list / note_remove 不会出现");
  }

  if (typeof c.on !== "function") {
    warn("ctx.on 不可用，保持项不会注入（请检查宿主版本）");
    return () => {};
  }

  const handler = async (
    payload: unknown,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const decision = await next();
    if (!resolved.enabled) return decision;
    const p = (payload ?? {}) as PreStepPayloadLike;
    const agent = p.agent;
    const sessionId = agent?.session?.id;
    if (
      agent === undefined ||
      typeof sessionId !== "string" ||
      sessionId === ""
    )
      return decision;
    let records;
    try {
      records = await store.list(sessionId);
    } catch (error) {
      warn(`读取保持项失败：${String(error)}`);
      return decision;
    }
    const desired = pinMessage(records);
    const claimed = p.messages ?? [];
    syncInbox(agent, claimed, desired);
    const d = (decision ?? {}) as DecisionLike;
    if (
      desired === undefined ||
      d.kind !== "enter" ||
      !Array.isArray(d.messages)
    )
      return decision;
    if (d.messages.some((message) => samePinPayload(message, desired)))
      return decision;
    if (alreadyInContext(agent, desired)) return decision;
    return { ...d, messages: foldMessages(d.messages, claimed, desired) };
  };

  return c.on("agent/pre-step", handler as (...args: unknown[]) => unknown);
}
