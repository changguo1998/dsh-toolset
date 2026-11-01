/**
 * 消费者调度层：注册归一、会话事件节点上的唤醒与对齐账本、`tools/pre-execute` 的 guard
 * 汇总。
 *
 * 唤醒时机由 `NODE_SCALES` 决定：`*-start` 清更细的窗口、`*-end` 查重后置位，同一尺度内
 * 不重复唤醒；`session` 尺度没有 end 节点，故不设窗口幂等。本层不注入，返回的反馈由
 * delivery 层统一交付，节流记账写在调用方传入的会话态里。
 */

import type { Segment } from "./delivery.ts";
import {
  NODE_SCALES,
  previewValue,
  scalesFrom,
  type Scale,
  type ScaleFlags,
  type SessionState,
} from "./engine-state.ts";
import { boundSummary } from "./match.ts";
import {
  CONSUMER_ONLY_SOURCE,
  isConsumerSource,
  isRuleDelivery,
  isRuleSource,
} from "./rules.ts";
import type {
  ConsumerContext,
  ConsumerFeedback,
  ConsumerRegistration,
  RuleDelivery,
  RuleSource,
  ToolGuardContext,
  ToolGuardDecision,
} from "./types.ts";

/** 归一化后的消费者注册项：`decide`（会话事件节点）与 `guard`（`tools/pre-execute`）至多一个。 */
export interface CompiledConsumer {
  id: string;
  /** 唤醒时机（节点表）。 */
  sources: readonly RuleSource[];
  delivery: RuleDelivery;
  cooldownTurns: number;
  cooldownMs: number;
  /** 按记录去重：投影里最多允许 N 条本反馈（0 = 无限制）。 */
  dedupeInRecord: number;
  /** 直写节点：这些节点跳过投影去重判断。 */
  directWrite: readonly RuleSource[];
  /** 会话事件节点的同步决策（guard 消费者没有）。 */
  decide?: (context: ConsumerContext) => ConsumerFeedback | null;
  /** `tools/pre-execute` 的裁决（guard 消费者才有）。 */
  guard?: (
    context: ToolGuardContext,
  ) => ToolGuardDecision | undefined | Promise<ToolGuardDecision | undefined>;
}

/** 注册归一结果：拒绝给一条告警，接受给归一化后的消费者与若干告警。 */
export type ConsumerCompileResult =
  | {
      readonly ok: true;
      readonly consumer: CompiledConsumer;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly warning: string };

/**
 * 注册入参归一（`isTaken` 用来判重）。
 *
 * 两种形态互斥：
 * - **会话事件节点**（`sources` 缺省 `["turn-end"]`）：按注册顺序**同步**询问 `decide`；
 * - **`tools/pre-execute`**（guard）：必须给 `guard`、不得给 `decide`，也不得带注入 / 冷却 /
 *   直写参数（违反即拒绝注册并告警）。
 */
export function compileConsumer(
  input: ConsumerRegistration,
  isTaken: (id: string) => boolean,
): ConsumerCompileResult {
  if (input === null || typeof input !== "object") {
    return { ok: false, warning: "registerConsumer 入参必须是对象" };
  }
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (id.length === 0) {
    return { ok: false, warning: "registerConsumer 的 id 必须是非空字符串" };
  }
  const sources = normalizeSources(input.sources);
  if (sources.includes(CONSUMER_ONLY_SOURCE)) {
    // guard 形态：结构上不属于注入面，注入 / 冷却 / 直写参数一律拒绝（避免「注册了却不生效」）
    const violation = guardRegistrationViolation(input);
    if (violation !== null) {
      return {
        ok: false,
        warning: `消费者 "${id}" ${violation}，注册被拒绝`,
      };
    }
    if (typeof input.guard !== "function") {
      return {
        ok: false,
        warning: `消费者 "${id}" 声明了 "${CONSUMER_ONLY_SOURCE}" 但没给 guard 函数，注册被拒绝`,
      };
    }
    if (isTaken(id)) {
      return { ok: false, warning: `消费者 "${id}" 已注册，重复注册被忽略` };
    }
    return {
      ok: true,
      warnings: [],
      consumer: {
        id,
        sources,
        delivery: "followup",
        cooldownTurns: 0,
        cooldownMs: 0,
        dedupeInRecord: 0,
        directWrite: [],
        guard: input.guard,
      },
    };
  }
  if (typeof input.decide !== "function") {
    return { ok: false, warning: `消费者 "${id}" 的 decide 必须是函数` };
  }
  if (isTaken(id)) {
    return { ok: false, warning: `消费者 "${id}" 已注册，重复注册被忽略` };
  }
  const warnings: string[] = [];
  if (input.delivery !== undefined && !isRuleDelivery(input.delivery)) {
    warnings.push(
      `消费者 "${id}" 的 delivery ${JSON.stringify(input.delivery)} 非法，按 followup 处理`,
    );
  }
  const consumer: CompiledConsumer = {
    id,
    sources,
    delivery: isRuleDelivery(input.delivery) ? input.delivery : "followup",
    cooldownTurns: normalizeCooldown(input.cooldownTurns),
    cooldownMs: normalizeCooldown(input.cooldownMs),
    dedupeInRecord: normalizeCount(input.dedupeInRecord),
    directWrite: normalizeDirectWriteNodes(
      input.directWrite,
      sources,
      `消费者 "${id}"`,
      (message) => warnings.push(message),
    ),
    decide: input.decide,
  };
  return { ok: true, consumer, warnings };
}

/** 一次消费者收集的入参。 */
export interface ConsumerCollectionInput {
  readonly consumers: readonly CompiledConsumer[];
  readonly trigger: RuleSource;
  readonly text: string;
  readonly sessionId: string;
  readonly turn: number;
  /** 本会话内存态（只读 `resumed`，就地记 `consumerFired` 与对齐 flag）。 */
  readonly state: SessionState;
  /** 原样透传给消费者的宿主事件载荷。 */
  readonly event: unknown;
  /** 本次节点的时刻（每个节点取一次）。 */
  readonly now: () => number;
  /** 会话记录里本引擎注入某摘要的条数（按记录去重用）。 */
  readonly countInRecord: (sessionId: string, key: string) => number;
  readonly warn: (message: string) => void;
  /** 产出段收集处（按注册顺序追加）。 */
  readonly segments: Segment[];
}

/** 消费者唤醒收集：对齐 flag → 冷却 → decide → 记录计数去重 → 产出段。 */
export function collectConsumerSegments(input: ConsumerCollectionInput): void {
  const { consumers, trigger, text, sessionId, turn, state, segments } = input;
  if (consumers.length === 0) return;
  const node = NODE_SCALES.get(trigger);
  const now = input.now();
  for (const consumer of consumers) {
    // guard 消费者（`tools/pre-execute`）不参与会话事件节点：没有 decide 就没有可注入的反馈
    const decide = consumer.decide;
    if (decide === undefined) continue;
    const registered = consumer.sources.includes(trigger);
    let wake = registered;
    if (node !== undefined) {
      const flags = flagsOf(state, consumer.id);
      wake =
        node.kind === "start"
          ? bookkeepStart(flags, node.scale, registered)
          : bookkeepEnd(flags, node.scale, registered);
    }
    if (!wake) continue;
    const last = state.consumerFired.get(consumer.id);
    if (last !== undefined) {
      if (
        consumer.cooldownTurns > 0 &&
        turn - last.turn < consumer.cooldownTurns
      )
        continue;
      if (consumer.cooldownMs > 0 && now - last.time < consumer.cooldownMs)
        continue;
    }
    let feedback: ConsumerFeedback | null = null;
    try {
      feedback = decide({
        sessionId,
        turn,
        text,
        trigger,
        event: input.event,
        // 消费者 ctx 与规则侧同一口径：可直接喂给匹配器复用内置谓词
        resumed: state.resumed,
      });
    } catch (err) {
      input.warn(`消费者 "${consumer.id}" decide 抛错：${String(err)}`);
      continue;
    }
    if (feedback === null || feedback === undefined) continue;
    if (feedback.reset === true) clearFlags(state, consumer.id);
    const feedbackText =
      typeof feedback.text === "string" ? feedback.text.trim() : "";
    if (feedbackText.length === 0) {
      input.warn(`消费者 "${consumer.id}" 反馈正文为空，已跳过`);
      continue;
    }
    const summary =
      typeof feedback.summary === "string" && feedback.summary.trim().length > 0
        ? feedback.summary
        : boundSummary(feedbackText);
    if (
      !consumer.directWrite.includes(trigger) &&
      consumer.dedupeInRecord > 0 &&
      input.countInRecord(sessionId, summary) >= consumer.dedupeInRecord
    ) {
      state.consumerFired.set(consumer.id, { turn, time: now });
      continue;
    }
    state.consumerFired.set(consumer.id, { turn, time: now });
    segments.push({
      sourceId: `consumer:${consumer.id}`,
      delivery: consumer.delivery,
      text: feedbackText,
      summary,
    });
  }
}

/**
 * `tools/pre-execute` 汇总（guard 面）：按消费者**注册顺序串行**询问注册在该节点的 guard。
 *
 * - 返回 `{kind:"deny", reason}` 立即结束：安全向优先，`allow` **不**否决后续 `deny`；
 * - 全部放行 / 弃权 → `undefined`（调用方走宿主 `next()`）；
 * - `guard` 抛错 / 返回非法结构 / `deny` 但理由为空 → 告警并视为弃权（fail-open：
 *   最终否决权仍在 `security-guard`，本层不因消费者故障而拦死工具）；
 * - `deny` 时打一行告警（可见性）；**不**写审计、不落 memory-base。
 *
 * `resumed` 由调用方按会话级判据补齐（显式给出时以其为准），其余字段原样透传。
 */
export async function guardDecision(
  consumers: readonly CompiledConsumer[],
  context: ToolGuardContext,
  resumedOf: (sessionId: string) => boolean | undefined,
  warn: (message: string) => void,
): Promise<ToolGuardDecision | undefined> {
  const exec = normalizeGuardContext(context, resumedOf, warn);
  if (exec === null) return undefined;
  for (const consumer of consumers) {
    const guard = consumer.guard;
    if (guard === undefined) continue;
    let decision: unknown;
    try {
      decision = await guard(exec);
    } catch (err) {
      warn(`消费者 "${consumer.id}" guard 抛错：${String(err)}`);
      continue;
    }
    if (decision === undefined || decision === null) continue;
    const kind = (decision as { kind?: unknown }).kind;
    if (kind === "allow") continue;
    if (kind !== "deny") {
      warn(
        `消费者 "${consumer.id}" guard 返回非法裁决 ${previewValue(decision)}，已视为弃权`,
      );
      continue;
    }
    const rawReason = (decision as { reason?: unknown }).reason;
    const reason = typeof rawReason === "string" ? rawReason.trim() : "";
    if (reason.length === 0) {
      warn(`消费者 "${consumer.id}" guard 拒绝但未给理由，已视为弃权`);
      continue;
    }
    warn(`消费者 "${consumer.id}" 拒绝工具 ${exec.name}`);
    return { kind: "deny", reason };
  }
  return undefined;
}

/**
 * guard 上下文归一：`name` 必须是非空字符串（否则告警弃权）；
 * `resumed` 缺省时按本会话已知的判定补齐（未知会话按 false = fresh，与纯函数调用同口径）。
 */
function normalizeGuardContext(
  context: ToolGuardContext,
  resumedOf: (sessionId: string) => boolean | undefined,
  warn: (message: string) => void,
): ToolGuardContext | null {
  const name =
    context !== null && typeof context === "object"
      ? (context as { name?: unknown }).name
      : undefined;
  if (typeof name !== "string" || name.length === 0) {
    warn(
      `tools/pre-execute 的 exec.name ${previewValue(name)} 非法，本次不询问消费者 guard`,
    );
    return null;
  }
  const callId =
    typeof context.callId === "string" && context.callId.length > 0
      ? context.callId
      : undefined;
  const sessionId =
    typeof context.sessionId === "string" && context.sessionId.length > 0
      ? context.sessionId
      : undefined;
  const resumed =
    typeof context.resumed === "boolean"
      ? context.resumed
      : sessionId === undefined
        ? false
        : (resumedOf(sessionId) ?? false);
  return {
    name,
    arguments: context.arguments,
    ...(callId === undefined ? {} : { callId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    resumed,
  };
}

/** 只做窗口账簿（不唤醒）：异常收尾的 `turn/end` 等场景。 */
export function touchScales(
  consumers: readonly CompiledConsumer[],
  state: SessionState,
  trigger: RuleSource,
  turn: number,
): void {
  const node = NODE_SCALES.get(trigger);
  if (node === undefined) return;
  state.turn = Math.max(state.turn, turn);
  for (const consumer of consumers) {
    const flags = flagsOf(state, consumer.id);
    if (node.kind === "start") bookkeepStart(flags, node.scale, false);
    else bookkeepEnd(flags, node.scale, false);
  }
}

/** 消费者对齐 flag（按需创建）。 */
function flagsOf(state: SessionState, consumerId: string): ScaleFlags {
  let flags = state.consumerFlags.get(consumerId);
  if (flags === undefined) {
    flags = { startFired: new Set(), endFired: new Set() };
    state.consumerFlags.set(consumerId, flags);
  }
  return flags;
}

/** 清空消费者的对齐 flag（`reset` 指定值）。 */
function clearFlags(state: SessionState, consumerId: string): void {
  state.consumerFlags.delete(consumerId);
}

/**
 * 时机表 `*-start`：清本尺度及更细的 endFired、清更细的 startFired；只有注册的节点才置位并唤醒。
 * `session` 尺度没有 end 节点 → 不设窗口幂等（每次到达都唤醒）。
 */
function bookkeepStart(
  flags: ScaleFlags,
  scale: Scale,
  registered: boolean,
): boolean {
  for (const item of scalesFrom(scale)) {
    flags.endFired.delete(item);
    if (item !== scale) flags.startFired.delete(item);
  }
  if (!registered) return false;
  if (scale === "session") return true;
  if (flags.startFired.has(scale)) return false;
  flags.startFired.add(scale);
  return true;
}

/**
 * 时机表 `*-end`：查本尺度及更细的 endFired（注册的节点才唤醒）→ 置位；
 * 「清 startFired[本尺度]」与是否唤醒无关（窗口关闭即清）。
 */
function bookkeepEnd(
  flags: ScaleFlags,
  scale: Scale,
  registered: boolean,
): boolean {
  const duplicated = scalesFrom(scale).some((item) => flags.endFired.has(item));
  const wake = registered && !duplicated;
  flags.startFired.delete(scale);
  if (wake) flags.endFired.add(scale);
  return wake;
}

/** 冷却参数兜底（非正有限数取 0）。 */
function normalizeCooldown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** 去重计数兜底（布尔兼容：true → 1、false → 0；非正 / 非法取 0 = 无限制）。 */
function normalizeCount(value: unknown): number {
  if (value === true) return 1;
  if (value === false || value === undefined) return 0;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** 消费者直写节点兜底：须落在唤醒时机内；非法 / 越界项丢弃并告警。 */
function normalizeDirectWriteNodes(
  value: unknown,
  sources: readonly RuleSource[],
  owner: string,
  warn: (message: string) => void,
): readonly RuleSource[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warn(`${owner} 的 directWrite 不是数组，已忽略`);
    return [];
  }
  const out: RuleSource[] = [];
  for (const item of value) {
    if (!isRuleSource(item)) {
      warn(
        `${owner} 的 directWrite 含非法节点 ${JSON.stringify(item)}，已忽略`,
      );
      continue;
    }
    if (!sources.includes(item)) {
      warn(`${owner} 的 directWrite 节点 "${item}" 不在唤醒时机内，已忽略`);
      continue;
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * 消费者唤醒时机兜底：缺省 `["turn-end"]`；按**消费者口径**过滤（含 `tools/pre-execute`），
 * 全非法同样退回缺省。
 */
function normalizeSources(value: unknown): readonly RuleSource[] {
  if (!Array.isArray(value)) return ["turn-end"];
  const list = value.filter((item) => isConsumerSource(item));
  return list.length > 0 ? list : ["turn-end"];
}

/** guard 形态注册的非法参数检查：命中返回原因（拒绝注册），全部合规返回 null。 */
function guardRegistrationViolation(
  input: ConsumerRegistration,
): string | null {
  if (input.decide !== undefined) {
    return `声明了 "${CONSUMER_ONLY_SOURCE}" 时不能同时给 decide（guard 只裁决、不注入反馈）`;
  }
  for (const key of [
    "delivery",
    "dedupeInRecord",
    "directWrite",
    "cooldownTurns",
    "cooldownMs",
  ] as const) {
    if (input[key] !== undefined) {
      return `声明了 "${CONSUMER_ONLY_SOURCE}" 时不能带 ${key}（guard 不注入、不去重、不记账）`;
    }
  }
  return null;
}
