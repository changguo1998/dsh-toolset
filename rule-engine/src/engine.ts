/**
 * 规则引擎编排层：会话事件 → 正文聚合 → 命中判定 → 节流/去重 → 交付注入器。
 *
 * 与宿主解耦：事件按结构面形态传入（SessionLike / SessionEventLike），注入经 `Injector`
 * 抽象（真实实现见 inject.ts，负责推迟宏任务与 host 调用），单测可塞假实现。
 *
 * 匹配面与判定时机：
 * - `assistant-text`：`assistant/message` 累积该回合正文，`turn/end` 时对整回合正文判定；
 * - `turn-end`：`turn/end` 时判定（match 可省 = 无条件命中）；
 * - `tool-call` / `tool-result`：事件到达即判定（注入仍由注入器推迟；送达路径由 delivery 决定）。
 *
 * 消费者面（registerConsumer）：turn-end 时按注册顺序**同步**依次询问，聚合其反馈
 * （返回 `{text, summary?}`）并统一注入。
 *
 * 节流与去重（同一会话内）：每规则 `cooldownTurns` / `cooldownMs`；每回合注入条数上限
 * `maxInjectionsPerTurn`；同一回合内相同正文只注入一次（不同规则同文案也只发一条）。
 *
 * **红线**：本层可能在 `Session.append` 的同步派发窗口内被调用，因此不得在此同步调用
 * `agent.followup()`（会撞重入保护导致消息不落盘）——推迟由注入器负责。
 */

import {
  boundSummary,
  compileMatcher,
  messageText,
  toolCallText,
  type CompiledMatcher,
} from "./match.ts";
import {
  effectiveRules,
  isRuleSource,
  normalizeRule,
  RULE_SOURCES,
} from "./rules.ts";
import { emptyLayer, loadLayer, saveLayer } from "./persist.ts";
import type {
  ConsumerContext,
  ConsumerFeedback,
  ConsumerRegistration,
  EffectiveRule,
  EngineStatus,
  EvaluateInput,
  EvaluateResult,
  Injector,
  MatchTestResult,
  NormalizedRule,
  Rule,
  RuleDelivery,
  RuleHit,
  RuleOrigin,
  RuleSource,
  RuleSummary,
  RuntimeLayer,
  SessionEventLike,
  SessionLike,
} from "./types.ts";

/** 每回合正文缓冲上限（字符），超出截断（防长回复把内存撑大）。 */
const TEXT_BUFFER_LIMIT = 20_000;

/** 保留的回合缓冲数（只留最近几回合）。 */
const TURN_BUFFER_KEEP = 4;

/** 会话内存态上限（超过后淘汰最早插入的会话）。 */
const SESSION_STATE_LIMIT = 64;

/** 允许触发注入的回合结束原因：用户中断/报错/分叉的回合不注入（避免对着中断空转追问）。 */
const INJECTABLE_TURN_REASONS: ReadonlySet<string> = new Set([
  "completed",
  "max-tokens",
]);

/** 编译后的规则（归一化数据 + 匹配器 + 来源层）。 */
interface CompiledRule {
  rule: NormalizedRule;
  origin: RuleOrigin;
  matcher: CompiledMatcher;
}

/** 归一化后的消费者注册项。 */
interface CompiledConsumer {
  id: string;
  delivery: RuleDelivery;
  cooldownTurns: number;
  cooldownMs: number;
  decide(context: ConsumerContext): ConsumerFeedback | null;
}

/** 单会话内存态（回合号、节流记账、正文缓冲）。 */
interface SessionState {
  /** 最近一次见到的回合号。 */
  turn: number;
  /** 本会话各回合的注入用量（条数 + 已用正文，用于上限与同内容去重）。 */
  injected: Map<number, TurnUsage>;
  /** 每规则最近一次命中（回合号 + 时刻）。 */
  fired: Map<string, { turn: number; time: number }>;
  /** 每消费者最近一次反馈（回合号 + 时刻）。 */
  consumerFired: Map<string, { turn: number; time: number }>;
  /** 回合正文缓冲：turn → 各 step 正文。 */
  buffers: Map<number, string[]>;
}

/** 单回合注入用量。 */
interface TurnUsage {
  count: number;
  texts: Set<string>;
}

/** 引擎构造参数。 */
export interface EngineOptions {
  /** 配置基线规则（只读）。 */
  baseline: readonly Rule[];
  /** 状态目录（运行时层落盘位置）。 */
  stateDir: string;
  /** 注入器（宿主送达面）。 */
  injector: Injector;
  /** 同一会话同一来源回合的注入上限，缺省 3。 */
  maxInjectionsPerTurn?: number;
  /** 时钟（测试缝），缺省 Date.now。 */
  now?: () => number;
  /** 告警出口，缺省 stderr。**注入方负责加前缀**（引擎只给正文）；缺省兜底自带 `[rule-engine] warn: `。 */
  warn?: (message: string) => void;
}

/** 变更类操作的返回（工具面直接把 error 回给模型）。 */
export interface MutationResult {
  ok: boolean;
  error: string | null;
  rule: NormalizedRule | null;
}

/** 规则引擎：持有生效规则集、会话内存态与运行时层持久化。 */
export class RuleEngine {
  readonly #stateDir: string;
  readonly #injector: Injector;
  readonly #maxInjectionsPerTurn: number;
  readonly #now: () => number;
  readonly #warn: (message: string) => void;
  readonly #baseline: readonly Rule[];
  readonly #sessions = new Map<string, SessionState>();
  /** 已注册消费者（按注册顺序依次询问）。 */
  #consumers: CompiledConsumer[] = [];
  #layer: RuntimeLayer;
  #readOnly: boolean;
  #compiled: CompiledRule[];

  constructor(options: EngineOptions) {
    this.#stateDir = options.stateDir;
    this.#injector = options.injector;
    this.#maxInjectionsPerTurn = Math.max(
      1,
      Math.floor(options.maxInjectionsPerTurn ?? 3),
    );
    this.#now = options.now ?? Date.now;
    this.#warn =
      options.warn ??
      // 宿主未注入时的兜底：自带一层前缀（注入方负责加前缀，见 EngineOptions.warn）
      ((message) => process.stderr.write(`[rule-engine] warn: ${message}\n`));
    this.#baseline = options.baseline;
    const loaded = loadLayer(this.#stateDir);
    for (const warning of loaded.warnings) this.#warn(`${warning}`);
    this.#layer = loaded.layer;
    this.#readOnly = loaded.readOnly;
    this.#compiled = this.#compile();
  }

  /** 重新编译生效规则集（构造与每次变更后调用）。 */
  #compile(): CompiledRule[] {
    const { rules, warnings } = effectiveRules(this.#baseline, this.#layer);
    for (const warning of warnings) this.#warn(`${warning}`);
    const compiled: CompiledRule[] = [];
    for (const { rule, origin } of rules) {
      const matcher = compileMatcher(rule.match, rule.source);
      for (const warning of matcher.warnings) {
        this.#warn(`规则 "${rule.id}"：${warning}`);
      }
      compiled.push({ rule, origin, matcher });
    }
    return compiled;
  }

  /** 只读清单（provide 查询面与 rule_list 共用）。 */
  list(): EffectiveRule[] {
    return this.#compiled.map((item) => ({
      rule: item.rule,
      origin: item.origin,
    }));
  }

  /** 只读状态。 */
  status(): EngineStatus {
    const runtime = this.#compiled.filter((item) => item.origin === "runtime");
    return {
      rules: this.#compiled.length,
      runtimeRules: runtime.length,
      removedBaselineRules: this.#layer.removed.length,
      stateDir: this.#stateDir,
      maxInjectionsPerTurn: this.#maxInjectionsPerTurn,
    };
  }

  /** 只读清单（扁平化，供宿主面板/命令消费）。 */
  summaries(): RuleSummary[] {
    return this.#compiled.map(({ rule, origin }) => ({
      id: rule.id,
      enabled: rule.enabled,
      source: rule.source,
      delivery: rule.delivery,
      origin,
      description: rule.description,
      text: rule.action.text,
      cooldownTurns: rule.cooldownTurns,
      cooldownMs: rule.cooldownMs,
    }));
  }

  /**
   * 简单消费者注册面：turn-end 时按注册顺序**同步**询问 `decide`，返回的反馈内容
   * 由本引擎统一注入（每回合上限 / 同文本去重 / 可选消费者冷却）。返回注销函数；
   * 重复 id / 非法注册记 warning 并返回 noop。
   */
  registerConsumer(input: ConsumerRegistration): () => void {
    const noop = (): void => {};
    if (input === null || typeof input !== "object") {
      this.#warn("registerConsumer 入参必须是对象");
      return noop;
    }
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (id.length === 0) {
      this.#warn("registerConsumer 的 id 必须是非空字符串");
      return noop;
    }
    if (typeof input.decide !== "function") {
      this.#warn(`消费者 "${id}" 的 decide 必须是函数`);
      return noop;
    }
    if (this.#consumers.some((item) => item.id === id)) {
      this.#warn(`消费者 "${id}" 已注册，重复注册被忽略`);
      return noop;
    }
    if (
      input.delivery !== undefined &&
      input.delivery !== "followup" &&
      input.delivery !== "next-step"
    ) {
      this.#warn(
        `消费者 "${id}" 的 delivery ${JSON.stringify(input.delivery)} 非法，按 followup 处理`,
      );
    }
    const consumer: CompiledConsumer = {
      id,
      delivery: input.delivery === "next-step" ? "next-step" : "followup",
      cooldownTurns: normalizeCooldown(input.cooldownTurns),
      cooldownMs: normalizeCooldown(input.cooldownMs),
      decide: input.decide,
    };
    this.#consumers = [...this.#consumers, consumer];
    return () => {
      this.#consumers = this.#consumers.filter((item) => item !== consumer);
    };
  }

  /** 新增规则（id 已存在则报错，指向 rule_update）。 */
  add(input: unknown): MutationResult {
    const normalized = normalizeRule(input);
    if (!normalized.ok)
      return { ok: false, error: normalized.error, rule: null };
    if (this.#compiled.some((item) => item.rule.id === normalized.rule.id)) {
      return {
        ok: false,
        error: `规则 "${normalized.rule.id}" 已存在（改配置用 rule_update，重建用 rule_remove 后再 add）`,
        rule: null,
      };
    }
    this.#layer.rules = [...this.#layer.rules, normalized.rule];
    this.#layer.removed = this.#layer.removed.filter(
      (id) => id !== normalized.rule.id,
    );
    return this.#commit(normalized.rule, normalized.warnings);
  }

  /** 更新规则：以生效规则为底，浅合并 patch 后写运行时层（基线规则被覆盖为运行时版本）。 */
  update(id: string, patch: unknown): MutationResult {
    const current = this.#compiled.find((item) => item.rule.id === id);
    if (current === undefined) {
      return { ok: false, error: `规则 "${id}" 不存在`, rule: null };
    }
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      return { ok: false, error: "patch 必须是对象", rule: null };
    }
    const p = patch as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...current.rule };
    for (const key of [
      "enabled",
      "source",
      "delivery",
      "match",
      "cooldownTurns",
      "cooldownMs",
      "description",
    ] as const) {
      if (p[key] !== undefined) merged[key] = p[key];
    }
    // action 浅合并（text / summary 可单独改）
    if (p["action"] !== undefined) {
      const actionPatch = p["action"];
      if (
        actionPatch !== null &&
        typeof actionPatch === "object" &&
        !Array.isArray(actionPatch)
      ) {
        merged["action"] = {
          ...current.rule.action,
          ...(actionPatch as Record<string, unknown>),
        };
      } else {
        return { ok: false, error: "action 必须是对象", rule: null };
      }
    }
    const normalized = normalizeRule(merged);
    if (!normalized.ok)
      return { ok: false, error: normalized.error, rule: null };
    const index = this.#layer.rules.findIndex((rule) => rule.id === id);
    if (index >= 0) this.#layer.rules[index] = normalized.rule;
    else this.#layer.rules = [...this.#layer.rules, normalized.rule];
    this.#layer.removed = this.#layer.removed.filter((item) => item !== id);
    return this.#commit(normalized.rule, normalized.warnings);
  }

  /** 删除规则：运行时规则直接移除；基线规则记入 removed 屏蔽。 */
  remove(id: string): MutationResult {
    const exists =
      this.#compiled.some((item) => item.rule.id === id) ||
      this.#layer.rules.some((rule) => rule.id === id);
    if (!exists) return { ok: false, error: `规则 "${id}" 不存在`, rule: null };
    this.#layer.rules = this.#layer.rules.filter((rule) => rule.id !== id);
    const inBaseline = effectiveRules(this.#baseline, emptyLayer()).rules.some(
      (item) => item.rule.id === id,
    );
    if (inBaseline && !this.#layer.removed.includes(id)) {
      this.#layer.removed = [...this.#layer.removed, id];
    }
    return this.#commit(null, []);
  }

  /** 只读判定（消费者 API）：返回命中规则（含可注入内容）与未启用规则；不注入、不改状态。 */
  evaluate(input: EvaluateInput): EvaluateResult {
    const source: RuleSource =
      input.source !== undefined && isRuleSource(input.source)
        ? input.source
        : "assistant-text";
    const matched: RuleHit[] = [];
    const disabled: string[] = [];
    for (const item of this.#compiled) {
      if (item.rule.source !== source) continue;
      if (!item.rule.enabled) {
        disabled.push(item.rule.id);
        continue;
      }
      if (!item.matcher.match(input.text)) continue;
      const text = item.rule.action.text;
      matched.push({
        id: item.rule.id,
        origin: item.origin,
        source: item.rule.source,
        delivery: item.rule.delivery,
        description: item.rule.description,
        text,
        summary: item.rule.action.summary ?? boundSummary(text),
      });
    }
    return { source, matched, disabled };
  }

  /** 干跑（工具面）：evaluate 的薄包装，输出命中 / 未启用规则 id。 */
  test(input: EvaluateInput): MatchTestResult {
    const result = this.evaluate(input);
    return {
      source: result.source,
      matched: result.matched.map((hit) => hit.id),
      disabled: result.disabled,
    };
  }

  /** 落盘 + 重编译 + 组装结果。 */
  #commit(rule: NormalizedRule | null, warnings: string[]): MutationResult {
    for (const warning of warnings) this.#warn(`${warning}`);
    const saved = saveLayer(this.#stateDir, this.#layer, {
      readOnly: this.#readOnly,
    });
    if (saved.warning !== null) this.#warn(`${saved.warning}`);
    this.#compiled = this.#compile();
    if (!saved.ok) {
      return {
        ok: false,
        error: `规则变更未能落盘（进程内已生效）：${saved.warning ?? "未知原因"}`,
        rule,
      };
    }
    return { ok: true, error: null, rule };
  }

  /** 会话内存态（按需创建；超限淘汰最早插入的会话）。 */
  #session(sessionId: string): SessionState {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    if (this.#sessions.size >= SESSION_STATE_LIMIT) {
      const oldest = this.#sessions.keys().next();
      if (!oldest.done) this.#sessions.delete(oldest.value);
    }
    const state: SessionState = {
      turn: 0,
      injected: new Map(),
      fired: new Map(),
      consumerFired: new Map(),
      buffers: new Map(),
    };
    this.#sessions.set(sessionId, state);
    return state;
  }

  /** 事件入口：按事件类型分流（畸形事件安全跳过）。 */
  handle(session: SessionLike, event: SessionEventLike): void {
    const sessionId = typeof session?.id === "string" ? session.id : "";
    if (sessionId.length === 0) return;
    if (
      event === null ||
      typeof event !== "object" ||
      typeof event.type !== "string"
    )
      return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "assistant/message": {
        const state = this.#session(sessionId);
        const turn = numberOr(data["turn"], state.turn);
        state.turn = Math.max(state.turn, turn);
        this.#buffer(state, turn, messageText(data["message"]));
        return;
      }
      case "tool/call": {
        const state = this.#session(sessionId);
        const turn = numberOr(data["turn"], state.turn);
        state.turn = Math.max(state.turn, turn);
        this.#evaluate(
          "tool-call",
          toolCallText(data["name"], data["arguments"]),
          sessionId,
          turn,
        );
        return;
      }
      case "tool/result": {
        const state = this.#session(sessionId);
        const turn = numberOr(data["turn"], state.turn);
        state.turn = Math.max(state.turn, turn);
        this.#evaluate(
          "tool-result",
          messageText(data["message"]),
          sessionId,
          turn,
        );
        return;
      }
      case "turn/end": {
        const state = this.#session(sessionId);
        const turn = numberOr(data["turn"], state.turn);
        state.turn = Math.max(state.turn, turn);
        const reason =
          typeof data["reason"] === "string" ? data["reason"] : "completed";
        const text = (state.buffers.get(turn) ?? []).join("\n");
        this.#pruneBuffers(state, turn);
        if (INJECTABLE_TURN_REASONS.has(reason)) {
          this.#evaluate("assistant-text", text, sessionId, turn);
          this.#evaluate("turn-end", text, sessionId, turn);
          this.#askConsumers(text, sessionId, turn, state);
        }
        this.#pruneCounters(state, turn);
        return;
      }
      default:
        return;
    }
  }

  /** 回合正文缓冲（只对文本类规则生效的会话保留，超长截断）。 */
  #buffer(state: SessionState, turn: number, text: string): void {
    if (text.length === 0) return;
    if (!this.#needsText()) return;
    const list = state.buffers.get(turn) ?? [];
    list.push(text.slice(0, TEXT_BUFFER_LIMIT));
    state.buffers.set(turn, list);
  }

  /** 是否需要回合正文（文本类规则或已注册消费者都要；无则完全不缓冲，省内存）。 */
  #needsText(): boolean {
    if (this.#consumers.length > 0) return true;
    return this.#compiled.some(
      (item) =>
        item.rule.enabled &&
        (item.rule.source === "assistant-text" ||
          item.rule.source === "turn-end"),
    );
  }

  /** 丢弃过旧回合缓冲与计数。 */
  #pruneBuffers(state: SessionState, keepTurn: number): void {
    for (const turn of state.buffers.keys()) {
      if (turn < keepTurn - TURN_BUFFER_KEEP) state.buffers.delete(turn);
    }
    state.buffers.delete(keepTurn);
  }

  /** 丢弃过旧回合的注入计数。 */
  #pruneCounters(state: SessionState, keepTurn: number): void {
    for (const turn of state.injected.keys()) {
      if (turn < keepTurn - TURN_BUFFER_KEEP) state.injected.delete(turn);
    }
  }

  /** 对某匹配面判定并逐条派发（命中 → 节流 → 注入）。 */
  #evaluate(
    source: RuleSource,
    text: string,
    sessionId: string,
    turn: number,
  ): void {
    if (RULE_SOURCES.indexOf(source) < 0) return;
    const state = this.#session(sessionId);
    for (const item of this.#compiled) {
      if (!item.rule.enabled || item.rule.source !== source) continue;
      if (!item.matcher.match(text)) continue;
      this.#fire(item.rule, sessionId, turn, state);
    }
  }

  /** turn-end 调度：按注册顺序同步询问消费者，聚合反馈并统一注入。 */
  #askConsumers(
    text: string,
    sessionId: string,
    turn: number,
    state: SessionState,
  ): void {
    if (this.#consumers.length === 0) return;
    const context: ConsumerContext = {
      sessionId,
      turn,
      text,
      trigger: "turn-end",
    };
    for (const consumer of this.#consumers) {
      const now = this.#now();
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
        feedback = consumer.decide(context);
      } catch (err) {
        this.#warn(`消费者 "${consumer.id}" decide 抛错：${String(err)}`);
        continue;
      }
      if (feedback === null || feedback === undefined) continue;
      const feedbackText =
        typeof feedback.text === "string" ? feedback.text.trim() : "";
      if (feedbackText.length === 0) {
        this.#warn(`消费者 "${consumer.id}" 反馈正文为空，已跳过`);
        continue;
      }
      // 与规则共用通用闸门：每回合上限 + 同正文去重
      const usage = state.injected.get(turn) ?? {
        count: 0,
        texts: new Set<string>(),
      };
      if (usage.count >= this.#maxInjectionsPerTurn) continue;
      if (usage.texts.has(feedbackText)) continue;
      const summary =
        typeof feedback.summary === "string" &&
        feedback.summary.trim().length > 0
          ? feedback.summary
          : boundSummary(feedbackText);
      try {
        this.#injector.inject({
          sourceId: `consumer:${consumer.id}`,
          sessionId,
          delivery: consumer.delivery,
          text: feedbackText,
          summary,
        });
      } catch (err) {
        this.#warn(`消费者 "${consumer.id}" 注入失败：${String(err)}`);
        continue;
      }
      usage.count += 1;
      usage.texts.add(feedbackText);
      state.injected.set(turn, usage);
      state.consumerFired.set(consumer.id, { turn, time: now });
    }
  }

  /** 节流与去重闸门；通过则交付注入器并记账。 */
  #fire(
    rule: NormalizedRule,
    sessionId: string,
    turn: number,
    state: SessionState,
  ): void {
    // 1) 规则级节流：回合间隔与毫秒间隔
    const now = this.#now();
    const last = state.fired.get(rule.id);
    if (last !== undefined) {
      if (rule.cooldownTurns > 0 && turn - last.turn < rule.cooldownTurns)
        return;
      if (rule.cooldownMs > 0 && now - last.time < rule.cooldownMs) return;
    }
    // 2) 回合级闸门：条数上限 + 同内容只发一次
    const text = rule.action.text;
    const usage = state.injected.get(turn) ?? {
      count: 0,
      texts: new Set<string>(),
    };
    if (usage.count >= this.#maxInjectionsPerTurn) return;
    if (usage.texts.has(text)) return;
    // 3) 交付注入器（其内部负责推迟宏任务；抛错只记 warning）
    const summary = rule.action.summary ?? boundSummary(text);
    try {
      this.#injector.inject({
        sourceId: rule.id,
        sessionId,
        delivery: rule.delivery,
        text,
        summary,
      });
    } catch (err) {
      this.#warn(`规则 "${rule.id}" 注入失败：${String(err)}`);
      return;
    }
    state.fired.set(rule.id, { turn, time: now });
    usage.count += 1;
    usage.texts.add(text);
    state.injected.set(turn, usage);
  }
}

/** 数值字段兜底（非有限数取 fallback）。 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 冷却参数兜底（非正有限数取 0）。 */
function normalizeCooldown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}
