/**
 * 集成层装配器: 用假工具面 / 假事件面 / 假服务面拼出本包的 `apply` 与 rule-engine 接线.
 *
 * 三个假面的形状 (与总规范 4.2 一致):
 * - 假工具面: `tools/pre-execute` 的 waterfall —— 本包不注册工具, 只把自身作为 guard 消费者挂到
 *   该节点; 装配器按注册顺序链式派发, 第一个返回 `deny` 的胜出, 返回 `undefined` 的弃权并交给
 *   下一位消费者与宿主;
 * - 假事件面: `ctx.on` 保存监听器, `emit("dispose")` 按注册顺序触发 (对应宿主卸载生命周期);
 * - 假服务面: `ctx.get("ruleEngine")` 返回假消费者注册面 (`registerConsumer`), 也可按真实 cordis
 *   的两种取法之一暴露为直接属性 `ctx.ruleEngine`.
 *
 * 只装配与派发, 不放断言; 断言在 `tests/integration/*.test.ts`.
 */

import type {
  Config,
  ToolGuardContext,
  ToolGuardDecision,
} from "../src/index.ts";
import { apply } from "../src/index.ts";

/** 消费者注册项 (rule-engine 注册面的结构子集). */
export interface ConsumerInputLike {
  id: string;
  sources: readonly string[];
  guard(context: ToolGuardContext): ToolGuardDecision | undefined;
}

/** 假消费者注册面: 记注册项与注销次数, 可切换注册被拒 / 无注销函数两种形态. */
export interface FakeEngine {
  consumers: ConsumerInputLike[];
  /** 注销函数被调用了几次. */
  unregisterCalls: number;
  /** 注册时抛错 (模拟框架拒绝). */
  reject: boolean;
  /** 注册成功但不返回注销函数. */
  noDisposer: boolean;
  registerConsumer(input: ConsumerInputLike): (() => void) | undefined;
}

/** 假事件面: `on` 保存监听器, `emit` 返回被触发的监听器数. */
export interface FakeEvents {
  listeners: Map<string, Array<() => void>>;
  on(event: string, listener: () => void): () => void;
  emit(event: string): number;
}

/** 装配选项. */
export interface AssembleOptions {
  config?: Config;
  /** 服务面取得方式: `get` = `ctx.get("ruleEngine")` (缺省), `direct` = `ctx.ruleEngine`, `none` = 不给服务. */
  expose?: "get" | "direct" | "none";
  /** 假引擎行为: `reject` 注册抛错, `noDisposer` 注册后不返回注销函数. */
  engine?: { reject?: boolean; noDisposer?: boolean };
  /** 事件面: `true` (缺省) 提供 `on`, `false` 不给 `on`, `throw` 让 `on` 抛错. */
  events?: boolean | "throw";
  /** 让 `ctx.on` 之外再抛错的取值面 (严格模式下未注入服务直读会抛). */
  strictDirect?: boolean;
}

/** 装配结果. */
export interface Assembled {
  engine: FakeEngine;
  events: FakeEvents;
  /** `apply` 期间打到 stderr 的告警行 (去掉前缀与换行). */
  warnings: string[];
  /** 注册到的消费者 (通常 0 或 1 条). */
  consumers: ConsumerInputLike[];
  /** `apply` 的返回值. */
  dispose: () => void;
  /** 宿主侧派发一次 `tools/pre-execute`: 按注册顺序调用, 首个 deny 胜出, 全弃权返回 undefined. */
  dispatch(context: ToolGuardContext): ToolGuardDecision | undefined;
  /** 只调唯一注册消费者的 guard (没注册时直接失败). */
  guard(context: ToolGuardContext): ToolGuardDecision | undefined;
}

/** 捕获 stderr 跑一段代码 (结束后恢复), 返回写入的行. */
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

/** 建一个假消费者注册面. */
function createFakeEngine(options: {
  reject?: boolean;
  noDisposer?: boolean;
}): FakeEngine {
  const engine: FakeEngine = {
    consumers: [],
    unregisterCalls: 0,
    reject: options.reject === true,
    noDisposer: options.noDisposer === true,
    registerConsumer(input: ConsumerInputLike): (() => void) | undefined {
      if (engine.reject) throw new Error("注册被拒绝");
      engine.consumers.push(input);
      if (engine.noDisposer) return undefined;
      return () => {
        engine.unregisterCalls += 1;
      };
    },
  };
  return engine;
}

/** 建一个假事件面. */
function createFakeEvents(throws: boolean): FakeEvents {
  const events: FakeEvents = {
    listeners: new Map(),
    on(event: string, listener: () => void): () => void {
      if (throws) throw new Error(`无该事件: ${event}`);
      const list = events.listeners.get(event) ?? [];
      list.push(listener);
      events.listeners.set(event, list);
      return () => {
        const current = events.listeners.get(event) ?? [];
        events.listeners.set(
          event,
          current.filter((item) => item !== listener),
        );
      };
    },
    emit(event: string): number {
      const list = [...(events.listeners.get(event) ?? [])];
      for (const listener of list) listener();
      return list.length;
    },
  };
  return events;
}

/** 拼装本包的 `apply` 与宿主接线. */
export function assemble(options: AssembleOptions = {}): Assembled {
  const engine = createFakeEngine(options.engine ?? {});
  const events = createFakeEvents(options.events === "throw");
  const expose = options.expose ?? "get";

  const ctx: Record<string, unknown> = {};
  if (expose === "get") {
    ctx["get"] = (service: string) =>
      service === "ruleEngine" ? engine : undefined;
  }
  if (expose === "direct") {
    ctx["ruleEngine"] = engine;
  }
  if (options.strictDirect === true) {
    // 严格模式下未注入服务直读会抛; `get` 仍是可用取法 (缺省按缺席处理)
    Object.defineProperty(ctx, "ruleEngine", {
      get() {
        throw new Error("cannot get property");
      },
    });
  }
  if (options.events !== false) {
    ctx["on"] = events.on;
  }

  const warnings: string[] = [];
  let dispose: () => void = () => {};
  const raw = captureStderr(() => {
    dispose = apply(ctx, options.config);
  });
  for (const line of raw) {
    const text = line.trim();
    if (text.length > 0) warnings.push(text);
  }

  const dispatch = (
    context: ToolGuardContext,
  ): ToolGuardDecision | undefined => {
    for (const consumer of engine.consumers) {
      if (!consumer.sources.includes("tools/pre-execute")) continue;
      const decision = consumer.guard(context);
      if (decision !== undefined) return decision;
    }
    return undefined;
  };

  return {
    engine,
    events,
    warnings,
    consumers: engine.consumers,
    dispose,
    dispatch,
    guard(context: ToolGuardContext): ToolGuardDecision | undefined {
      const [consumer] = engine.consumers;
      if (consumer === undefined) throw new Error("没有注册任何消费者");
      return consumer.guard(context);
    },
  };
}
