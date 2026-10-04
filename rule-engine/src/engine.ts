/**
 * 规则引擎编排层：会话事件 → 正文聚合 → 命中判定 → 节流/去重 → 交付注入器。
 *
 * 与宿主解耦：事件按结构面形态传入（SessionLike / SessionEventLike），注入经 `Injector`
 * 抽象（真实实现见 inject.ts，负责推迟宏任务与 host 调用），单测可塞假实现。
 *
 * 节点表（规则与消费者共用）：assistant-text / user-message / tool-call / tool-result /
 * turn-start / turn-end / step-start / step-end / session-start / compaction。
 * 判定时机：文本类节点在事件到达时取文本载荷（assistant-text 由 `assistant/message` 缓冲、
 * `turn/end` 时判定；tool-call / tool-result / user-message 即时判定）；边界类节点
 * （turn-start / step-start / step-end / session-start / compaction）文本为空串，match 可省 =
 * 无条件命中。
 *
 * 消费者面（registerConsumer）：按注册的 `sources` 在对应节点被唤醒（缺省 `["turn-end"]`），
 * 返回 `{text, summary?, reset?}`；与规则命中统一走「逐段闸门 → 按 delivery 分组 → 合并成
 * 一条注入」。对齐点合并（尺度 session / turn / step / tool 的双 flag）见 README。
 *
 * 节流与去重（同一会话内）：每规则 `cooldownTurns` / `cooldownMs`；每回合注入条数上限
 * `maxInjectionsPerTurn`；同一回合内相同正文只注入一次（不同规则同文案也只发一条）；
 * `dedupeInRecord` 规则再按**会话记录**去重（可见投影 + 未消费 inbox，读面由接线层合成；
 * 重载不重复注入，压缩后记录里没了才补）；
 * 声明在 `directWrite` 里的节点**跳过该去重判断**直接写入（规则与消费者同口径）。
 *
 * **红线**：本层可能在 `Session.append` 的同步派发窗口内被调用，因此不得在此同步调用
 * `agent.followup()`（会撞重入保护导致消息不落盘）——推迟由注入器负责。
 */

import { SOURCE_KIND } from "./inject.ts";
import {
  boundSummary,
  compileMatcher,
  messageText,
  toolCallText,
  type CompiledMatcher,
} from "./match.ts";
import {
  effectiveRules,
  isRuleDelivery,
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

/** 单条 `assistant/message` 正文的缓冲上限（字符），超出截断（防长回复把内存撑大）。 */
const TEXT_BUFFER_LIMIT = 20_000;

/** 保留的回合缓冲数（只留最近几回合）。 */
const TURN_BUFFER_KEEP = 4;

/** 会话内存态上限（超过后淘汰最早插入的会话）。 */
const SESSION_STATE_LIMIT = 64;

/** 允许触发注入的回合结束原因（只认 `completed` / `max-tokens`）：中断 / 报错 / 阻塞 / 分叉的
 *  回合不注入（避免对着中断空转追问）。 */
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
  /** 唤醒时机（节点表）。 */
  sources: readonly RuleSource[];
  delivery: RuleDelivery;
  cooldownTurns: number;
  cooldownMs: number;
  /** 按记录去重：投影里最多允许 N 条本反馈（0 = 无限制）。 */
  dedupeInRecord: number;
  /** 直写节点：这些节点跳过投影去重判断。 */
  directWrite: readonly RuleSource[];
  decide(context: ConsumerContext): ConsumerFeedback | null;
}

/** 对齐尺度（越靠后越细）。 */
type Scale = "session" | "turn" | "step" | "tool";

const SCALE_ORDER: readonly Scale[] = ["session", "turn", "step", "tool"];

/** 节点 → 尺度与类（不在此表 = 不参与对齐合并，如 `compaction`）。 */
const NODE_SCALES: ReadonlyMap<
  RuleSource,
  { scale: Scale; kind: "start" | "end" }
> = new Map([
  ["session-start", { scale: "session", kind: "start" }],
  ["user-message", { scale: "turn", kind: "start" }],
  ["turn-start", { scale: "turn", kind: "start" }],
  ["assistant-text", { scale: "turn", kind: "end" }],
  ["turn-end", { scale: "turn", kind: "end" }],
  ["step-start", { scale: "step", kind: "start" }],
  ["step-end", { scale: "step", kind: "end" }],
  ["tool-call", { scale: "tool", kind: "start" }],
  ["tool-result", { scale: "tool", kind: "end" }],
]);

/** 每消费者的对齐 flag（Set 成员 = true，缺省 = false）。 */
interface ScaleFlags {
  startFired: Set<Scale>;
  endFired: Set<Scale>;
}

/** 待注入的一段（规则命中或消费者反馈）。 */
interface Segment {
  sourceId: string;
  delivery: RuleDelivery;
  text: string;
  summary: string;
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
  /** 每消费者的对齐 flag（尺度 × start / end）。 */
  consumerFlags: Map<string, ScaleFlags>;
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
  /** 会话记录读取（`dedupeInRecord` 判据；接线层合成「可见投影 + 未消费 inbox」）；
   *  缺省或读不到 → 去重失效、照旧注入。 */
  messagesOf?: (sessionId: string) => readonly unknown[];
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
  readonly #messagesOf: ((sessionId: string) => readonly unknown[]) | undefined;
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
    this.#messagesOf = options.messagesOf;
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
      const matcher = compileMatcher(rule.match);
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
      sources: rule.sources,
      directWrite: rule.directWrite,
      delivery: rule.delivery,
      origin,
      description: rule.description,
      text: rule.action.text,
      cooldownTurns: rule.cooldownTurns,
      cooldownMs: rule.cooldownMs,
    }));
  }

  /**
   * 简单消费者注册面：在注册的 `sources`（缺省 `["turn-end"]`）节点按注册顺序**同步**询问
   * `decide`，返回的反馈内容由本引擎统一注入（每回合上限 / 同文本去重 / 可选消费者冷却）。
   * 返回注销函数；重复 id / 非法注册记 warning 并返回 noop。
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
    if (input.delivery !== undefined && !isRuleDelivery(input.delivery)) {
      this.#warn(
        `消费者 "${id}" 的 delivery ${JSON.stringify(input.delivery)} 非法，按 followup 处理`,
      );
    }
    const sources = normalizeSources(input.sources);
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
        this.#warn,
      ),
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
      "delivery",
      "match",
      "cooldownTurns",
      "cooldownMs",
      "dedupeInRecord",
      "directWrite",
      "description",
    ] as const) {
      if (p[key] !== undefined) merged[key] = p[key];
    }
    // 匹配面：patch 的 source / sources 覆盖（并清掉另一个键，避免归一化读到旧值）
    if (p["source"] !== undefined || p["sources"] !== undefined) {
      delete merged["sources"];
      merged["source"] = p["source"] !== undefined ? p["source"] : p["sources"];
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
      if (!item.rule.sources.includes(source)) continue;
      if (!item.rule.enabled) {
        disabled.push(item.rule.id);
        continue;
      }
      if (!item.matcher.match(input.text, source)) continue;
      const text = item.rule.action.text;
      matched.push({
        id: item.rule.id,
        origin: item.origin,
        source,
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
      consumerFlags: new Map(),
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
      case "turn/start": {
        this.#entry(sessionId, data, "turn-start", "", event);
        return;
      }
      case "user/message": {
        // 排除本引擎自己的注入（避免 `user-message` 节点自触发）
        const message = data["message"];
        const kind = (message as { source?: { kind?: unknown } } | null)?.source
          ?.kind;
        if (kind === SOURCE_KIND) return;
        this.#entry(
          sessionId,
          data,
          "user-message",
          messageText(message),
          event,
        );
        return;
      }
      case "step/start": {
        this.#entry(sessionId, data, "step-start", "", event);
        return;
      }
      case "step/end": {
        this.#entry(sessionId, data, "step-end", "", event);
        return;
      }
      case "tool/call": {
        this.#entry(
          sessionId,
          data,
          "tool-call",
          toolCallText(data["name"], data["arguments"]),
          event,
        );
        return;
      }
      case "tool/result": {
        this.#entry(
          sessionId,
          data,
          "tool-result",
          messageText(data["message"]),
          event,
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
          this.#dispatch("assistant-text", text, sessionId, turn, event);
          this.#dispatch("turn-end", text, sessionId, turn, event);
        } else {
          // 异常收尾：不唤醒，但仍按「窗口关闭」清 startFired（时机表「被吞时」列）
          this.#touchScale(sessionId, "turn-end", turn);
        }
        this.#pruneCounters(state, turn);
        return;
      }
      case "compaction/end": {
        // 上下文压缩完成（一次压缩一条：summary / prune 都在 start→end 之内，只认终态，
        // 避免同一次压缩触发多次）
        this.#entry(sessionId, data, "compaction", "", event);
        return;
      }
      default:
        return;
    }
  }

  /** 回合正文缓冲（有文本类规则或已注册消费者时才缓冲，超长截断）。 */
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
        (item.rule.sources.includes("assistant-text") ||
          item.rule.sources.includes("turn-end")),
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

  /** 对某节点判定并派发（统一入口；内部不抛）。 */
  #dispatch(
    trigger: RuleSource,
    text: string,
    sessionId: string,
    turn: number,
    event?: unknown,
  ): void {
    try {
      const state = this.#session(sessionId);
      const segments: Segment[] = [];
      this.#collectRules(trigger, text, sessionId, turn, state, segments);
      this.#collectConsumers(
        trigger,
        text,
        sessionId,
        turn,
        state,
        segments,
        event,
      );
      this.#write(segments, sessionId, turn, state);
    } catch (err) {
      this.#warn(`节点 "${trigger}" 派发失败：${String(err)}`);
    }
  }

  /** 事件入口统一形态：取回合号 → 派发。 */
  #entry(
    sessionId: string,
    data: Record<string, unknown>,
    trigger: RuleSource,
    text: string,
    event: unknown,
  ): void {
    const state = this.#session(sessionId);
    const turn = numberOr(data["turn"], state.turn);
    state.turn = Math.max(state.turn, turn);
    this.#dispatch(trigger, text, sessionId, turn, event);
  }

  /** 规则命中收集：规则级节流 → 投影计数去重 → 产出段。 */
  #collectRules(
    trigger: RuleSource,
    text: string,
    sessionId: string,
    turn: number,
    state: SessionState,
    segments: Segment[],
  ): void {
    for (const item of this.#compiled) {
      const rule = item.rule;
      if (!rule.enabled || !rule.sources.includes(trigger)) continue;
      if (!item.matcher.match(text, trigger)) continue;
      const now = this.#now();
      const last = state.fired.get(rule.id);
      if (last !== undefined) {
        if (rule.cooldownTurns > 0 && turn - last.turn < rule.cooldownTurns)
          continue;
        if (rule.cooldownMs > 0 && now - last.time < rule.cooldownMs) continue;
      }
      const summary = rule.action.summary ?? boundSummary(rule.action.text);
      // 按记录去重：记录里已有 N 条本注入 → 不产出，仍记本次命中（避免每次触发都重读记录）；
      // 直写节点（directWrite）跳过该判断、直接写入
      if (
        !rule.directWrite.includes(trigger) &&
        rule.dedupeInRecord > 0 &&
        this.#countInRecord(sessionId, summary) >= rule.dedupeInRecord
      ) {
        state.fired.set(rule.id, { turn, time: now });
        continue;
      }
      state.fired.set(rule.id, { turn, time: now });
      segments.push({
        sourceId: rule.id,
        delivery: rule.delivery,
        text: rule.action.text,
        summary,
      });
    }
  }

  /** 消费者唤醒收集：对齐 flag → 冷却 → decide → 记录计数去重 → 产出段。 */
  #collectConsumers(
    trigger: RuleSource,
    text: string,
    sessionId: string,
    turn: number,
    state: SessionState,
    segments: Segment[],
    event: unknown,
  ): void {
    if (this.#consumers.length === 0) return;
    const node = NODE_SCALES.get(trigger);
    const now = this.#now();
    for (const consumer of this.#consumers) {
      const registered = consumer.sources.includes(trigger);
      let wake = registered;
      if (node !== undefined) {
        const flags = this.#flagsOf(state, consumer.id);
        wake =
          node.kind === "start"
            ? this.#bookkeepStart(flags, node.scale, registered)
            : this.#bookkeepEnd(flags, node.scale, registered);
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
        feedback = consumer.decide({ sessionId, turn, text, trigger, event });
      } catch (err) {
        this.#warn(`消费者 "${consumer.id}" decide 抛错：${String(err)}`);
        continue;
      }
      if (feedback === null || feedback === undefined) continue;
      if (feedback.reset === true) this.#clearFlags(state, consumer.id);
      const feedbackText =
        typeof feedback.text === "string" ? feedback.text.trim() : "";
      if (feedbackText.length === 0) {
        this.#warn(`消费者 "${consumer.id}" 反馈正文为空，已跳过`);
        continue;
      }
      const summary =
        typeof feedback.summary === "string" &&
        feedback.summary.trim().length > 0
          ? feedback.summary
          : boundSummary(feedbackText);
      if (
        !consumer.directWrite.includes(trigger) &&
        consumer.dedupeInRecord > 0 &&
        this.#countInRecord(sessionId, summary) >= consumer.dedupeInRecord
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

  /** 逐段闸门（段数上限 + 同正文去重）→ 按 delivery 分组 → 合并为一条写入。 */
  #write(
    segments: Segment[],
    sessionId: string,
    turn: number,
    state: SessionState,
  ): void {
    if (segments.length === 0) return;
    const groups = new Map<RuleDelivery, Segment[]>();
    for (const segment of segments) {
      const list = groups.get(segment.delivery) ?? [];
      list.push(segment);
      groups.set(segment.delivery, list);
    }
    for (const [delivery, list] of groups) {
      const usage = state.injected.get(turn) ?? {
        count: 0,
        texts: new Set<string>(),
      };
      const kept: Segment[] = [];
      for (const segment of list) {
        if (usage.count >= this.#maxInjectionsPerTurn) {
          this.#warn(
            `回合 ${turn} 注入段数已达上限 ${this.#maxInjectionsPerTurn}，来源 "${segment.sourceId}" 的注入跳过`,
          );
          continue;
        }
        if (usage.texts.has(segment.text)) continue;
        usage.count += 1;
        usage.texts.add(segment.text);
        kept.push(segment);
      }
      state.injected.set(turn, usage);
      if (kept.length === 0) continue;
      const sourceId = kept.map((item) => item.sourceId).join("+");
      try {
        this.#injector.inject({
          sourceId,
          sessionId,
          delivery,
          text: kept.map((item) => item.text).join("\n\n"),
          summary: kept[0]?.summary ?? "",
          // 合并注入（多段）时才带各段摘要；单段与 `summary` 相同，省略
          ...(kept.length > 1
            ? { summaries: kept.map((item) => item.summary) }
            : {}),
        });
      } catch (err) {
        this.#warn(`来源 "${sourceId}" 注入失败：${String(err)}`);
      }
    }
  }

  /** 只做窗口账簿（不唤醒）：异常收尾的 `turn/end` 等场景。 */
  #touchScale(sessionId: string, trigger: RuleSource, turn: number): void {
    const node = NODE_SCALES.get(trigger);
    if (node === undefined) return;
    const state = this.#session(sessionId);
    state.turn = Math.max(state.turn, turn);
    for (const consumer of this.#consumers) {
      const flags = this.#flagsOf(state, consumer.id);
      if (node.kind === "start") this.#bookkeepStart(flags, node.scale, false);
      else this.#bookkeepEnd(flags, node.scale, false);
    }
  }

  /** `session/created`（含恢复）→ `session-start` 节点；监听器永不抛。 */
  sessionCreated(sessionId: string, event?: unknown): void {
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    try {
      const state = this.#session(sessionId);
      this.#dispatch("session-start", "", sessionId, state.turn, event);
    } catch (err) {
      this.#warn(`session-start 派发失败：${String(err)}`);
    }
  }

  /** 消费者对齐 flag（按需创建）。 */
  #flagsOf(state: SessionState, consumerId: string): ScaleFlags {
    let flags = state.consumerFlags.get(consumerId);
    if (flags === undefined) {
      flags = { startFired: new Set(), endFired: new Set() };
      state.consumerFlags.set(consumerId, flags);
    }
    return flags;
  }

  /** 清空消费者的对齐 flag（`reset` 指定值）。 */
  #clearFlags(state: SessionState, consumerId: string): void {
    state.consumerFlags.delete(consumerId);
  }

  /**
   * 时机表 `*-start`：清本尺度及更细的 endFired、清更细的 startFired；只有注册的节点才置位并唤醒。
   * `session` 尺度没有 end 节点 → 不设窗口幂等（每次到达都唤醒）。
   */
  #bookkeepStart(
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
  #bookkeepEnd(flags: ScaleFlags, scale: Scale, registered: boolean): boolean {
    const duplicated = scalesFrom(scale).some((item) =>
      flags.endFired.has(item),
    );
    const wake = registered && !duplicated;
    flags.startFired.delete(scale);
    if (wake) flags.endFired.add(scale);
    return wake;
  }

  /** 会话记录里本引擎注入的条数（`summary` 或 `summaries` 命中该 key）；读面由接线层给出。 */
  #countInRecord(sessionId: string, key: string): number {
    const messages = this.#messagesOf?.(sessionId);
    if (!Array.isArray(messages)) return 0;
    let count = 0;
    for (const message of messages) {
      const source = (
        message as {
          source?: { kind?: unknown; summary?: unknown; summaries?: unknown };
        } | null
      )?.source;
      if (source?.kind !== SOURCE_KIND) continue;
      if (source.summary === key) {
        count += 1;
        continue;
      }
      if (Array.isArray(source.summaries) && source.summaries.includes(key)) {
        count += 1;
      }
    }
    return count;
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

/** 消费者唤醒时机兜底：缺省 `["turn-end"]`；过滤非法值，全非法同样退回缺省。 */
function normalizeSources(value: unknown): readonly RuleSource[] {
  if (!Array.isArray(value)) return ["turn-end"];
  const list = value.filter((item) => isRuleSource(item));
  return list.length > 0 ? list : ["turn-end"];
}

/** 本尺度及更细尺度（含自身，从粗到细）。 */
function scalesFrom(scale: Scale): Scale[] {
  return SCALE_ORDER.slice(SCALE_ORDER.indexOf(scale));
}
