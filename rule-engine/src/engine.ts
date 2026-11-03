/**
 * 规则引擎编排层：会话事件 → 正文聚合 → 命中判定 → 节流/去重 → 交付注入器。
 *
 * 分层（一个文件一层，本层只做事件分流与生命周期编排）：
 * - `engine-state.ts`：会话内存态、对齐尺度表与各层共用的数据形状；
 * - `evaluation.ts`：规则求值（匹配 / 冷却 / 按记录去重）与只读 `evaluate` 口径；
 * - `consumers.ts`：消费者注册归一、会话节点唤醒与 `tools/pre-execute` 的 guard 汇总；
 * - `delivery.ts`：待注入段的闸门、按 delivery 分组合并与注入器调用。
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
 * 会话级匹配上下文：`resumed`（本会话是否从记录恢复 / 重载，含 fork 继承）在**首次**见到该
 * 会话时判定一次并记住（见 #session），规则判定与消费者 `ctx` 都用它——`session-fresh` /
 * `session-resumed` 两个内置谓词的唯一依据。
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

import {
  collectConsumerSegments,
  compileConsumer,
  guardDecision,
  touchScales,
  type CompiledConsumer,
} from "./consumers.ts";
import { countInRecord, writeSegments, type Segment } from "./delivery.ts";
import {
  bufferText,
  previewValue,
  pruneBuffers,
  pruneCounters,
  sessionStateOf,
  type SessionState,
} from "./engine-state.ts";
import {
  collectRuleSegments,
  compileRules,
  evaluateRules,
  type CompiledRule,
} from "./evaluation.ts";
import { SOURCE_KIND } from "./inject.ts";
import { messageText, toolCallText } from "./match.ts";
import { emptyLayer, loadLayer, saveLayer } from "./persist.ts";
import { effectiveRules, normalizeRule } from "./rules.ts";
import type {
  ConsumerRegistration,
  EffectiveRule,
  EngineStatus,
  EvaluateInput,
  EvaluateResult,
  Injector,
  MatchTestResult,
  NormalizedRule,
  Rule,
  RuleSource,
  RuleSummary,
  RuntimeLayer,
  SessionEventLike,
  SessionLike,
  ToolGuardContext,
  ToolGuardDecision,
} from "./types.ts";

/** 允许触发注入的回合结束原因（只认 `completed` / `max-tokens`）：中断 / 报错 / 阻塞 / 分叉的
 *  回合不注入（避免对着中断空转追问）。 */
const INJECTABLE_TURN_REASONS: ReadonlySet<string> = new Set([
  "completed",
  "max-tokens",
]);

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
    return compileRules(this.#baseline, this.#layer, this.#warn);
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
   * 消费者注册面。两种形态见 consumers.ts 的 `compileConsumer`；反馈由本引擎统一注入
   * （每回合上限 / 同文本去重 / 可选消费者冷却），guard 形态走 `guardTool`。
   *
   * 返回注销函数；重复 id / 非法注册记 warning 并返回 noop。
   */
  registerConsumer(input: ConsumerRegistration): () => void {
    const noop = (): void => {};
    const result = compileConsumer(input, (id) =>
      this.#consumers.some((item) => item.id === id),
    );
    if (!result.ok) {
      this.#warn(result.warning);
      return noop;
    }
    for (const warning of result.warnings) this.#warn(warning);
    const consumer = result.consumer;
    this.#consumers = [...this.#consumers, consumer];
    return () => {
      this.#consumers = this.#consumers.filter((item) => item !== consumer);
    };
  }

  /** `tools/pre-execute` 汇总（guard 面）；判定细节与告警口径见 consumers.ts。 */
  guardTool(context: ToolGuardContext): Promise<ToolGuardDecision | undefined> {
    return guardDecision(
      this.#consumers,
      context,
      (sessionId) => this.#sessions.get(sessionId)?.resumed,
      this.#warn,
    );
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
    return evaluateRules(this.#compiled, input);
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

  /** 会话内存态（本次事件写入的会话）见 engine-state.ts 的 `sessionStateOf`。 */
  #session(sessionId: string, session?: unknown): SessionState {
    return sessionStateOf(this.#sessions, sessionId, session);
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
    // 每个分支都把宿主 `session` 传给 #session：错过 `session/created`（插件后挂载）时，
    // 首个事件就是判定 `resumed` 的兜底时机（此时该会话确有历史，判为 resumed 是正确的）
    switch (event.type) {
      case "assistant/message": {
        const state = this.#session(sessionId, session);
        const turn = numberOr(data["turn"], state.turn);
        state.turn = Math.max(state.turn, turn);
        // 更正事件（宿主 `SurfaceOp` 的 replace 形态：字符串或 `{op:"replace",startSeq,endSeq}`）
        // 不进回合正文——与 TUI 显示面一致（该区间在画面上被覆盖、不再代表模型可见内容），
        // 否则消费者会要求「修正」用户看不到的内容。
        if (isCorrectiveEvent(event, data)) return;
        this.#buffer(state, turn, messageText(data["message"]));
        return;
      }
      case "turn/start": {
        this.#entry(sessionId, data, "turn-start", "", event, session);
        return;
      }
      case "user/message": {
        // 更正事件（replace 形态）不入缓冲：与 `assistant/message` 同口径。
        if (isCorrectiveEvent(event, data)) return;
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
          session,
        );
        return;
      }
      case "step/start": {
        this.#entry(sessionId, data, "step-start", "", event, session);
        return;
      }
      case "step/end": {
        this.#entry(sessionId, data, "step-end", "", event, session);
        return;
      }
      case "tool/call": {
        this.#entry(
          sessionId,
          data,
          "tool-call",
          toolCallText(data["name"], data["arguments"]),
          event,
          session,
        );
        return;
      }
      case "tool/result": {
        // 更正事件（replace 形态）不入缓冲：与正文 / 用户消息同口径。
        if (isCorrectiveEvent(event, data)) return;
        this.#entry(
          sessionId,
          data,
          "tool-result",
          messageText(data["message"]),
          event,
          session,
        );
        return;
      }
      case "turn/end": {
        const state = this.#session(sessionId, session);
        const turn = numberOr(data["turn"], state.turn);
        state.turn = Math.max(state.turn, turn);
        const reason = this.#turnEndReason(data["reason"], turn);
        const text = (state.buffers.get(turn) ?? []).join("\n");
        pruneBuffers(state, turn);
        if (reason !== null && INJECTABLE_TURN_REASONS.has(reason)) {
          this.#dispatch("assistant-text", text, sessionId, turn, event);
          this.#dispatch("turn-end", text, sessionId, turn, event);
        } else {
          // 异常收尾：不唤醒，但仍按「窗口关闭」清 startFired（时机表「被吞时」列）
          touchScales(this.#consumers, state, "turn-end", turn);
        }
        pruneCounters(state, turn);
        return;
      }
      case "compaction/end": {
        // 上下文压缩完成（一次压缩一条：summary / prune 都在 start→end 之内，只认终态，
        // 避免同一次压缩触发多次）
        this.#entry(sessionId, data, "compaction", "", event, session);
        return;
      }
      default:
        return;
    }
  }

  /**
   * `turn/end` 的 `reason` 归一：字符串按字面判定（语义不变）；对象读 `kind`（宿主的结构化
   * 判别联合形态，TUI 侧 `turnEndReason` 同口径）；缺省（事件不带该字段）按 `completed`。
   * 其余非法值（`null` / 数字 / 布尔 / 空对象 / 数组 / `kind` 非字符串等）→ 返回 `null`，
   * 调用方按「不唤醒」处理并在此告警（不再默默当成正常收尾）。
   */
  #turnEndReason(value: unknown, turn: number): string | null {
    if (value === undefined) return "completed";
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const kind = (value as { kind?: unknown }).kind;
      if (typeof kind === "string") return kind;
    }
    this.#warn(
      `回合 ${turn} 的 turn/end reason ${previewValue(value)} 非法（须为字符串或 { kind: string }），本回合不唤醒消费者与规则`,
    );
    return null;
  }

  /** 回合正文缓冲（有文本类规则或已注册消费者时才缓冲，超长截断）。 */
  #buffer(state: SessionState, turn: number, text: string): void {
    bufferText(state, turn, text, this.#needsText(), this.#warn);
  }

  /** 是否需要回合正文（有 `decide` 的消费者、或文本类规则；guard 消费者不需要，省内存）。 */
  #needsText(): boolean {
    if (this.#consumers.some((consumer) => consumer.decide !== undefined)) {
      return true;
    }
    return this.#compiled.some(
      (item) =>
        item.rule.enabled &&
        (item.rule.sources.includes("assistant-text") ||
          item.rule.sources.includes("turn-end")),
    );
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
      collectRuleSegments({
        compiled: this.#compiled,
        trigger,
        text,
        sessionId,
        turn,
        state,
        now: this.#now,
        countInRecord: (id, key) => this.#countInRecord(id, key),
        segments,
      });
      collectConsumerSegments({
        consumers: this.#consumers,
        trigger,
        text,
        sessionId,
        turn,
        state,
        event,
        now: this.#now,
        countInRecord: (id, key) => this.#countInRecord(id, key),
        warn: this.#warn,
        segments,
      });
      writeSegments({
        segments,
        sessionId,
        turn,
        maxInjectionsPerTurn: this.#maxInjectionsPerTurn,
        injected: state.injected,
        injector: this.#injector,
        warn: this.#warn,
      });
    } catch (err) {
      this.#warn(`节点 "${trigger}" 派发失败：${String(err)}`);
    }
  }

  /** 事件入口统一形态：取回合号 → 派发。`session` 只在首次建态时参与 `resumed` 判定。 */
  #entry(
    sessionId: string,
    data: Record<string, unknown>,
    trigger: RuleSource,
    text: string,
    event: unknown,
    session?: unknown,
  ): void {
    const state = this.#session(sessionId, session);
    const turn = numberOr(data["turn"], state.turn);
    state.turn = Math.max(state.turn, turn);
    this.#dispatch(trigger, text, sessionId, turn, event);
  }

  /**
   * `session/created`（含恢复）→ `session-start` 节点；监听器永不抛。
   *
   * 第二参是宿主 Session（结构面读 `seq` / `inheritedEventCount` 判 `resumed`），同时原样作为
   * 消费者的 `ctx.event` 透传。只给 sessionId 时（缺省）按 fresh 处理。
   */
  sessionCreated(sessionId: string, session?: unknown): void {
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    try {
      const state = this.#session(sessionId, session);
      this.#dispatch("session-start", "", sessionId, state.turn, session);
    } catch (err) {
      this.#warn(`session-start 派发失败：${String(err)}`);
    }
  }

  /** 会话记录里本引擎注入的条数（`summary` 或 `summaries` 命中该 key）；读面由接线层给出。 */
  #countInRecord(sessionId: string, key: string): number {
    return countInRecord(this.#messagesOf, sessionId, key);
  }
}

/** 数值字段兜底（非有限数取 fallback）。 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 更正事件判定：宿主 `SurfaceOp = 'append' | { op: 'replace', startSeq, endSeq }`
 * （`docs/host/DSH-CTX-API.md`），写在**事件顶层**（TUI 同口径），兼容放在 `data` 内；
 * 缺省（无标记）不是更正事件。
 */
function isCorrectiveEvent(
  event: unknown,
  data: Record<string, unknown>,
): boolean {
  const top = (event as { surfaceOp?: unknown } | null)?.surfaceOp;
  if (top !== undefined) return isReplaceOp(top);
  return isReplaceOp(data["surfaceOp"]);
}

/** `SurfaceOp` 是否为 replace 形态（字符串 `"replace"` 或 `{ op: "replace", … }`）。 */
function isReplaceOp(op: unknown): boolean {
  if (typeof op === "string") return op === "replace";
  if (op === null || typeof op !== "object") return false;
  return (op as { op?: unknown }).op === "replace";
}
