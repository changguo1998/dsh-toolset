/**
 * 集成层装配器: 假 rule-engine 消费者注册面 + 假事件派发面 + 假展示面 (provide / onReview / effect)。
 *
 * 三个假面的形状照 `rule-engine/src/types.ts` 的 `ConsumerRegistration` / `ConsumerContext`
 * 与 `rule-engine/src/inject.ts` 的 `buildInjectionMessage` 抄 (结构化类型, 不 import 对端实现):
 * - 消费者注册面: `registerConsumer(input)` 记下注册项并返回注销函数;
 * - 事件面: `emit(trigger, text)` 按 `sources` (缺省 `turn-end`) 唤醒 `decide`,
 *   等价 host 在 turn-end / session-start 等节点派发的事件;
 * - 展示面: 捕获 `provide("symbolNormalizer")` 的服务面, 按 `onReview` 订阅审查事件;
 *   `decide` 返回的反馈按 `delivery` 投影成宿主消息 (`[RULE] ` 前缀正文 + `source.summary`)。
 *
 * 本装配器不以 `.test.ts` 结尾, 不参与覆盖率统计 (只统 `src`)。
 */

import { apply, type Config } from "../src/index.ts";
import type { ReviewEvent, SymbolNormalizerService } from "../src/types.ts";

/** 消费者反馈 (对应 rule-engine 的 `ConsumerFeedback`)。 */
export interface ConsumerFeedback {
  text: string;
  summary?: string;
  reset?: boolean;
}

/** 唤醒上下文 (对应 rule-engine 的 `ConsumerContext` 的文本类子集)。 */
export interface ConsumerContext {
  sessionId: string;
  turn: number;
  text: string;
  trigger: string;
}

/** 消费者注册项 (对应 rule-engine 的 `ConsumerRegistration`)。 */
export interface ConsumerRegistration {
  id: string;
  sources?: readonly string[];
  delivery?: string;
  dedupeInRecord?: number;
  directWrite?: readonly string[];
  decide?(context: ConsumerContext): ConsumerFeedback | null;
}

/** 注册面最小形态 (对应 rule-engine provide 的 `ruleEngine`)。 */
export interface ConsumerSurface {
  registerConsumer(input: ConsumerRegistration): () => void;
}

/** 事件节点 (本插件注册的 sources 全集)。 */
export type NodeTrigger =
  "turn-end" | "session-start" | "compaction" | "step-end";

/** 一次注入: 事件节点 + 送达路径 + 投影后的消息。 */
export interface Delivery {
  trigger: string;
  via: string;
  message: Record<string, unknown>;
}

/** 装配体: 注册记录 / 派发 / 投影 / 展示面 / 告警 / 注销。 */
export interface Assembly {
  /** 记录里当前可见的注入摘要 (模拟「可见投影 + 未消费 inbox」, 按 sessionId 分账)。 */
  readonly record: ReadonlyMap<string, readonly string[]>;
  /** 注册项 (按注册顺序)。 */
  readonly registrations: readonly ConsumerRegistration[];
  /** 当前仍生效的注册项条数 (dispose 后归零)。 */
  readonly activeCount: number;
  /** 已送达的注入 (按派发顺序)。 */
  readonly delivered: readonly Delivery[];
  /** 展示面 `onReview` 收到的事件 (装配后自动订阅)。 */
  readonly events: readonly ReviewEvent[];
  /** 装配与运行期写 stderr 的告警行。 */
  readonly warnings: readonly string[];
  /** `provide("symbolNormalizer")` 的服务面; `provide` 缺席 / 抛错时为 undefined。 */
  readonly service: SymbolNormalizerService | undefined;
  /** 派发一个事件节点, 返回本次送达的注入。 */
  emit(
    trigger: NodeTrigger,
    text: string,
    options?: { sessionId?: string; turn?: number },
  ): Delivery[];
  /** 派发 `turn-end` (回合审查的缺省节点)。 */
  emitTurnEnd(
    text: string,
    options?: { sessionId?: string; turn?: number },
  ): Delivery[];
  /** 清空记录 (模拟压缩把旧注入挤出可见投影 / 恢复会话投影里本来就看得见)。 */
  clearRecord(sessionId?: string): void;
  /** 注销消费者 (模拟 cordis 卸载: 调用 effect 返回的清理函数)。 */
  dispose(): void;
}

/** 装配选项。 */
export interface AssembleOptions {
  /** `ruleEngine` 的取得方式: 直接属性 (缺省) / 完全缺席 / 注册即抛错。 */
  surface?: "property" | "absent" | "throwing";
  /** `provide` 的行为: 正常 (缺省) / 抛错。 */
  provide?: "function" | "throwing";
  /** `effect` 的行为: 注册清理 (缺省) / 缺席。 */
  effect?: "function" | "absent";
  /** 宿主会话 id (缺省 `s1`)。 */
  sessionId?: string;
}

/** 假注入面的消息序号 (确定性的 `id`, 便于断言非空而不依赖随机值)。 */
let messageSeq = 0;

/** 把一个反馈投影成宿主消息 (照 `buildInjectionMessage` 的三项硬要求)。 */
export function projectFeedback(
  feedback: ConsumerFeedback,
  summary: string,
): Record<string, unknown> {
  messageSeq += 1;
  return {
    id: `injected-${messageSeq}`,
    role: "user",
    content: [{ type: "text", text: `[RULE] ${feedback.text}` }],
    source: { kind: "rule-engine", summary },
  };
}

/** 从投影消息里取回复正文 (去掉注入前缀)。 */
export function projectedText(delivery: Delivery): string {
  const content = delivery.message["content"] as
    { type?: string; text?: string }[] | undefined;
  return (content?.[0]?.text ?? "").replace(/^\[RULE\] /, "");
}

/** 捕获一段代码里的 stderr 写入 (结束后恢复原函数)。 */
export function captureStderr(run: () => void): string[] {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes;
}

/**
 * 拼装 `apply` 与宿主接线: 假注册面 + 假展示面 → 本插件 `apply` → 派发事件 → 投影注入。
 * `surface: "absent"` 时给空 ctx, 用于断言「缺席告警且不注册」的对照。
 */
export async function assemble(
  config?: Config,
  options: AssembleOptions = {},
): Promise<Assembly> {
  const sessionId = options.sessionId ?? "s1";
  const registrations: ConsumerRegistration[] = [];
  const active = new Set<ConsumerRegistration>();
  const delivered: Delivery[] = [];
  const events: ReviewEvent[] = [];
  // 记录里的注入摘要 (模拟宿主 `deriveMessages()` 可见投影 + inbox 未消费注入)
  const record = new Map<string, string[]>();
  const warnings: string[] = [];
  const effects: Array<() => unknown> = [];
  let service: SymbolNormalizerService | undefined;

  const surface: ConsumerSurface = {
    registerConsumer(input: ConsumerRegistration): () => void {
      if (options.surface === "throwing") {
        throw new Error("registerConsumer 拒绝");
      }
      registrations.push(input);
      active.add(input);
      return () => {
        active.delete(input);
      };
    },
  };
  const ctx: Record<string, unknown> = {};
  if (options.surface !== "absent") ctx["ruleEngine"] = surface;
  if (options.provide === "throwing") {
    ctx["provide"] = (): void => {
      throw new Error("provide 拒绝");
    };
  } else {
    ctx["provide"] = (providedName: string, value: unknown): void => {
      if (providedName === "symbolNormalizer") {
        service = value as SymbolNormalizerService;
      }
    };
  }
  if (options.effect !== "absent") {
    ctx["effect"] = (fn: () => unknown): void => {
      effects.push(fn);
    };
  }

  warnings.push(
    ...captureStderr(() => {
      void apply(ctx, config);
    }).filter((line) => line.includes(" warn: ")),
  );
  // apply 是 async (内部全同步): 让微任务落地后再订阅展示面
  await Promise.resolve();
  service?.onReview((event) => {
    events.push(event);
  });

  const dispatch = (
    trigger: NodeTrigger,
    text: string,
    emitOptions: { sessionId?: string; turn?: number } = {},
  ): Delivery[] => {
    const before = delivered.length;
    const id = emitOptions.sessionId ?? sessionId;
    for (const registration of [...active]) {
      const sources = registration.sources ?? ["turn-end"];
      if (!sources.includes(trigger)) continue;
      const decide = registration.decide;
      if (typeof decide !== "function") continue;
      const outcomes: Array<ConsumerFeedback | null> = [];
      warnings.push(
        ...captureStderr(() => {
          outcomes.push(
            decide({
              sessionId: id,
              turn: emitOptions.turn ?? 1,
              text,
              trigger,
            }),
          );
        }),
      );
      const feedback = outcomes[0] ?? null;
      if (feedback === null) continue;
      // 记录去重 (顺序照 rule-engine consumers.ts: 先 decide 取 summary, 再按
      // dedupeInRecord 判断; 声明在 directWrite 里的节点跳过该判断)
      const summary = feedback.summary ?? "";
      const limit = registration.dedupeInRecord ?? 0;
      const direct = (registration.directWrite ?? []).includes(trigger);
      const visible = record.get(id) ?? [];
      if (
        !direct &&
        limit > 0 &&
        visible.filter((item) => item === summary).length >= limit
      )
        continue;
      visible.push(summary);
      record.set(id, visible);
      delivered.push({
        trigger,
        via: registration.delivery ?? "followup",
        message: projectFeedback(feedback, summary),
      });
    }
    return delivered.slice(before);
  };

  return {
    record,
    registrations,
    get activeCount(): number {
      return active.size;
    },
    delivered,
    events,
    warnings,
    get service(): SymbolNormalizerService | undefined {
      return service;
    },
    emit: dispatch,
    emitTurnEnd(text, emitOptions = {}) {
      return dispatch("turn-end", text, emitOptions);
    },
    clearRecord(id) {
      if (id === undefined) record.clear();
      else record.delete(id);
    },
    dispose() {
      for (const effect of effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") (cleanup as () => void)();
      }
    },
  };
}
