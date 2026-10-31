/**
 * 集成层装配器: 假 rule-engine 消费者注册面 + 假 `assistant-text` 派发面 + 假注入投影面。
 *
 * 三个假面的形状照 `rule-engine/src/types.ts` 的 `ConsumerRegistration` / `ConsumerContext`
 * 与 `rule-engine/src/inject.ts` 的 `buildInjectionMessage` 抄 (结构化类型, 不 import 对端实现):
 * - 消费者注册面: `registerConsumer(input)` 记下注册项并返回注销函数;
 * - 事件面: `emitAssistantText(text)` 按 `sources` 唤醒 `decide`, 等价宿主 `turn/end` 时的
 *   `assistant-text` 派发;
 * - 投影面: `decide` 返回的反馈按 `delivery` 投影成宿主消息 (`[RULE] ` 前缀正文 +
 *   `source.summary`), 即 rule-engine 真实注入器送达宿主的那条消息。
 *
 * 本装配器不以 `.test.ts` 结尾, 不参与覆盖率统计 (只统 `src`)。
 */

import { apply, type Config } from "../src/index.ts";

/** 消费者反馈 (对应 rule-engine 的 `ConsumerFeedback`)。 */
export interface ConsumerFeedback {
  text: string;
  summary?: string;
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
  delivery?: "steer" | "inject" | "followup";
  dedupeInRecord?: number;
  decide?(context: ConsumerContext): ConsumerFeedback | null;
}

/** 注册面最小形态 (对应 rule-engine provide 的 `ruleEngine`)。 */
export interface ConsumerSurface {
  registerConsumer(input: ConsumerRegistration): () => void;
}

/** 送达路径 (与宿主 `Agent` 的三个方法同名)。 */
export type DeliveryVia = "followup" | "steer" | "inject";

/** 一次注入: 送达路径 + 投影后的消息。 */
export interface Delivery {
  via: DeliveryVia;
  message: Record<string, unknown>;
}

/** 装配体: 注册记录 / 派发 / 投影 / 告警 / 注销。 */
export interface Assembly {
  /** 注册项 (按注册顺序)。 */
  readonly registrations: readonly ConsumerRegistration[];
  /** 当前仍生效的注册项条数 (dispose 后归零)。 */
  readonly activeCount: number;
  /** 已送达的注入 (按派发顺序)。 */
  readonly delivered: readonly Delivery[];
  /** 装配与运行期写 stderr 的告警行。 */
  readonly warnings: readonly string[];
  /** 按宿主口径派发一条 `assistant-text`, 返回本次送达的注入。 */
  emitAssistantText(
    text: string,
    options?: { sessionId?: string; turn?: number },
  ): Delivery[];
  /** 注销消费者。 */
  dispose(): void;
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

/** 装配选项。 */
export interface AssembleOptions {
  /** `ruleEngine` 的取得方式: 直接属性 (缺省) / `ctx.get("ruleEngine")` 回退 / 完全缺席。 */
  surface?: "property" | "get" | "absent";
  /** 宿主会话 id (缺省 `s1`)。 */
  sessionId?: string;
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
 * 拼装 `apply` 与宿主接线: 假注册面 → 本插件 `apply` → 派发 `assistant-text` → 投影注入。
 * `surface: "absent"` 时给空 ctx, 用于断言「缺席告警且不注册」的对照。
 */
export function assemble(
  config?: Config,
  options: AssembleOptions = {},
): Assembly {
  const sessionId = options.sessionId ?? "s1";
  const registrations: ConsumerRegistration[] = [];
  const active = new Set<ConsumerRegistration>();
  const delivered: Delivery[] = [];
  const warnings: string[] = [];
  const surface: ConsumerSurface = {
    registerConsumer(input: ConsumerRegistration): () => void {
      registrations.push(input);
      active.add(input);
      return () => {
        active.delete(input);
      };
    },
  };
  const ctx =
    options.surface === "get"
      ? {
          get: (key: string): unknown =>
            key === "ruleEngine" ? surface : undefined,
        }
      : options.surface === "absent"
        ? {}
        : { ruleEngine: surface };

  let dispose = (): void => {};
  warnings.push(
    ...captureStderr(() => {
      dispose = apply(ctx, config);
    }),
  );

  return {
    registrations,
    get activeCount(): number {
      return active.size;
    },
    delivered,
    warnings,
    emitAssistantText(text, emitOptions = {}) {
      const trigger = "assistant-text";
      const turn = emitOptions.turn ?? 1;
      const before = delivered.length;
      for (const registration of [...active]) {
        const sources = registration.sources ?? ["assistant-text"];
        if (!sources.includes(trigger)) continue;
        const decide = registration.decide;
        if (typeof decide !== "function") continue;
        const feedback = decide({
          sessionId: emitOptions.sessionId ?? sessionId,
          turn,
          text,
          trigger,
        });
        if (feedback === null) continue;
        delivered.push({
          via: registration.delivery ?? "followup",
          message: projectFeedback(feedback, feedback.summary ?? ""),
        });
      }
      return delivered.slice(before);
    },
    dispose() {
      dispose();
    },
  };
}
