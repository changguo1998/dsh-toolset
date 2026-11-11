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
 * 不投记忆库记录; hold 的动态保持不受影响, 不让宿主启动失败。
 */

import type { MemoryFaceLike, PinRecord } from "./store.ts";
import { DEFAULT_MAX_NOTES, PinStore } from "./store.ts";
import {
  hasText,
  isPinMessage,
  messageText,
  renderText,
  samePinPayload,
  textMessage,
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

/** 动态保持 provider 的入参（只读, 按步调用）。 */
export interface HoldContext {
  sessionId: string;
  turn?: number;
  step?: number;
}

/** 动态保持内容提供者：返回本步要在场的正文, `undefined` 表示本步不投。 */
export type HoldProvider = (
  context: HoldContext,
) => string | undefined | Promise<string | undefined>;

/** hold 登记项（同 key 只保留一条）。 */
interface HoldEntry {
  provider: HoldProvider;
}

/** 服务面 `pinNotes`：摘要 + 动态保持登记口（hold / release 不依赖记忆库）。 */
export interface PinNotesService {
  summary(sessionId: string): Promise<PinSummary>;
  hold(key: string, provider: HoldProvider): () => void;
  release(key: string): void;
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

/** 注入来源的 key：`pin_note` 记录来源为 undefined, hold 来源为登记 key。 */
function pinSummaryOf(message: PinMessageLike): string | undefined {
  const summary = (message.source as { summary?: unknown }).summary;
  return typeof summary === "string" ? summary : undefined;
}

/** 该 pending 是否属于指定来源（按 source.kind + summary 判定）。 */
function matchesSource(
  message: PinMessageLike,
  summary: string | undefined,
): boolean {
  return isPinMessage(message) && pinSummaryOf(message) === summary;
}

/** 有限数（provider 上下文取 turn / step 用）。 */
function asFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * 让 inbox 里某一来源的待消费消息收敛成一条（或无）。
 * 口径同 `agent-instructions`：已在本步 claim 的批次或会话投影里 → 全部清掉；同 payload 复用一条；
 * 否则替换第一条、删掉其余。
 */
function syncInbox(
  agent: AgentLike,
  claimed: readonly PinMessageLike[],
  desired: PinMessageLike | undefined,
  summary: string | undefined,
): void {
  const inbox = agent.inbox;
  if (inbox === undefined) return;
  const pending = (inbox.nextStep ?? []).filter((message) =>
    matchesSource(message, summary),
  );
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

/** 把一组 desired 按顺序插在最后一条本步 claim 的消息之后（找不到就插到最前）。 */
function foldMessages(
  messages: readonly PinMessageLike[],
  claimed: readonly PinMessageLike[],
  desireds: readonly PinMessageLike[],
): PinMessageLike[] {
  if (desireds.length === 0) return [...messages];
  let lastClaimed = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (claimed.includes(messages[i]!)) lastClaimed = i;
  }
  const at = lastClaimed + 1;
  return [...messages.slice(0, at), ...desireds, ...messages.slice(at)];
}

/**
 * 挂载：注册三个工具、暴露 `pinNotes` 服务面（含 hold / release）、订阅 `agent/pre-step`。
 *
 * 注入来源两类：记忆库记录（`pin_note` 写入, 一条）+ 各 hold key（每 key 一条）。
 * 每条按正文逐一 compare, 不在场的才插；同正文的两个来源只投一条。
 * hold / release 不依赖记忆库, 记忆库缺席时服务面照常暴露。
 * 返回 dispose（清空 hold 登记并注销订阅；工具注册面由宿主随插件卸载回收）。
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

  // 动态保持登记表：同 key 只保留一条 provider（重复登记告警后覆盖）
  const holds = new Map<string, HoldEntry>();
  // pre-step 订阅按需建立：记忆库可用时立即订；记忆库缺席时等第一次 hold 登记再订
  let off: (() => void) | undefined;
  let handler:
    | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
    | undefined;
  const subscribe = (): void => {
    if (off !== undefined || handler === undefined) return;
    if (typeof c.on !== "function") return;
    off = c.on("agent/pre-step", handler as (...args: unknown[]) => unknown);
  };
  const release = (key: string): void => {
    holds.delete(key);
  };
  const hold = (key: string, provider: HoldProvider): (() => void) => {
    if (key.trim() === "") {
      warn("hold 需要非空 key，已忽略");
      return () => {};
    }
    if (holds.has(key))
      warn(`hold 的 key「${key}」重复登记，已用新 provider 覆盖`);
    holds.set(key, { provider });
    subscribe();
    return () => release(key);
  };

  const memory = c.memory;
  let store: PinStore | undefined;
  if (memory === undefined || typeof memory.registerKind !== "function") {
    warn("ctx.memory 不可用，保持项不会注入（请检查 memory-base 是否挂载）");
  } else {
    const built = new PinStore(memory, { maxNotes: resolved.maxNotes });
    if (built.available) {
      store = built;
    } else {
      warn(
        `memory-base 分类 pin 注册失败（${built.unavailableReason ?? "原因未知"}），保持项不会注入`,
      );
    }
  }

  // 只读服务面：hold / release 不依赖记忆库, 记忆库缺席时仍暴露
  if (typeof c.provide === "function") {
    try {
      const service: PinNotesService = {
        summary: async (sessionId: string): Promise<PinSummary> => {
          if (store === undefined) return { count: 0, chars: 0, titles: [] };
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
        hold,
        release,
      };
      c.provide("pinNotes", service);
    } catch (error) {
      warn(`服务面 pinNotes 暴露失败（忽略）：${String(error)}`);
    }
  }

  if (typeof c.tools?.register === "function") {
    if (store !== undefined) {
      const tools: ToolDef[] = noteTools(store);
      for (const tool of tools) {
        try {
          c.tools.register(tool);
        } catch (error) {
          warn(`工具 ${tool.name} 注册失败：${String(error)}`);
        }
      }
    }
  } else {
    warn("ctx.tools 不可用，pin_note / note_list / note_remove 不会出现");
  }

  handler = async (
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
    const claimed = p.messages ?? [];
    const d = (decision ?? {}) as DecisionLike;

    // 来源 1：记忆库记录合成一条（零条时不投, 并在下面清掉旧 pending）
    let records: PinRecord[] = [];
    if (store !== undefined) {
      try {
        records = await store.list(sessionId);
      } catch (error) {
        warn(`读取保持项失败：${String(error)}`);
      }
    }
    const desireds = new Map<string | undefined, PinMessageLike>();
    const recordsText = renderText(records);
    if (recordsText !== undefined)
      desireds.set(undefined, textMessage(recordsText));

    // 来源 2：每个 hold key 一条；provider 抛错只跳过本条, 不影响其他来源
    const holdContext: HoldContext = { sessionId };
    const turn = asFinite((p as { turn?: unknown }).turn);
    if (turn !== undefined) holdContext.turn = turn;
    const step = asFinite((p as { step?: unknown }).step);
    if (step !== undefined) holdContext.step = step;
    for (const [key, entry] of holds) {
      let text: string | undefined;
      try {
        text = await entry.provider(holdContext);
      } catch (error) {
        warn(`hold「${key}」的 provider 抛错，本步跳过：${String(error)}`);
        continue;
      }
      if (typeof text !== "string" || text.trim() === "") continue;
      desireds.set(key, textMessage(text, key));
    }

    // 先按来源收敛 inbox：本步没产出的来源（含 provider 返回 undefined）清掉旧 pending
    const pendingKeys = new Set<string | undefined>();
    for (const message of agent.inbox?.nextStep ?? []) {
      if (isPinMessage(message)) pendingKeys.add(pinSummaryOf(message));
    }
    for (const key of pendingKeys) {
      if (!desireds.has(key)) syncInbox(agent, claimed, undefined, key);
    }
    for (const [key, message] of desireds) {
      syncInbox(agent, claimed, message, key);
    }

    if (d.kind !== "enter" || !Array.isArray(d.messages)) return decision;
    // 按正文逐条 compare：批次里已有同正文、或已在上下文里, 都不再插
    const toInsert: PinMessageLike[] = [];
    for (const message of desireds.values()) {
      const text = messageText(message);
      if (text === undefined) continue;
      if (hasText(d.messages, text)) continue;
      if (toInsert.some((item) => messageText(item) === text)) continue;
      if (alreadyInContext(agent, message)) continue;
      toInsert.push(message);
    }
    if (toInsert.length === 0) return decision;
    return { ...d, messages: foldMessages(d.messages, claimed, toInsert) };
  };

  if (typeof c.on === "function") {
    if (store !== undefined) subscribe();
  } else {
    warn("ctx.on 不可用，保持项不会注入（请检查宿主版本）");
  }
  return () => {
    holds.clear();
    off?.();
  };
}
