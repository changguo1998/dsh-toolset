/**
 * 集成层装配器: 用假服务面 / 假事件面 / 假工具面 / 假会话事件拼出本包的 `apply` 与宿主接线.
 *
 * 三个假面的形状 (与总规范 4.2 一致):
 * - 假服务面: `ctx.get("ruleEngine")` 返回假消费者注册面 (`registerConsumer`), 也可按真实 cordis
 *   的另一种取法暴露为直接属性 `ctx.ruleEngine`; 取不到时按服务缺席处理;
 * - 假事件面: `ctx.on` 保存监听器, `emit` 按注册顺序触发. 本包不订阅宿主生命周期, 该面用于守住
 *   「加载时不动宿主事件」;
 * - 假工具面: `ctx.tools.registerTool` 记注册项. 本包只注入不加工具, 该面用于守住「工具面为空」.
 *
 * 假会话事件: `fire(source)` 按 `sources` 节点找消费者并调 `decide`, 模拟 rule-engine 在
 * `session-start` / `step-end` 唤醒消费者取注入正文; 本包不落盘, 装配器不建临时目录.
 *
 * 只装配与派发, 不放断言; 断言在 `ponytail/tests/integration/plugin.test.ts`.
 */

import type { Config } from "../src/index.ts";
import { apply } from "../src/index.ts";

/** 一次唤醒的会话上下文 (rule-engine 传给 `decide` 的结构子集). */
export interface SessionContext {
  sessionId: string;
  turn: number;
  text?: string;
}

/** `decide` 的返回: 注入正文 + 可选摘要; `null` 表示本次不注入. */
export interface ConsumerOutput {
  text: string;
  summary?: string;
}

/** 消费者注册项 (rule-engine 注册面的结构子集). */
export interface ConsumerInputLike {
  id: string;
  sources?: readonly string[];
  delivery?: string;
  dedupeInRecord?: number;
  directWrite?: readonly string[];
  decide(context: SessionContext): ConsumerOutput | null;
}

/** 假消费者注册面: 记注册项与注销次数, 可切换注册抛错 / 不返回注销函数两种形态. */
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

/** 假工具面: 记注册项, 供断言「本包不注册工具」. */
export interface FakeTools {
  registered: unknown[];
  registerTool(input: unknown): void;
}

/** 装配选项. */
export interface AssembleOptions {
  config?: Config;
  /**
   * 服务面取得方式: `get` = `ctx.get("ruleEngine")` (缺省), `direct` = `ctx.ruleEngine`,
   * `broken` = 直接属性存在但没有 `registerConsumer` (半装配的服务面), `none` = 不给服务.
   */
  expose?: "get" | "direct" | "broken" | "none";
  /** 假注册面行为: `reject` 注册抛错, `noDisposer` 注册后不返回注销函数. */
  engine?: { reject?: boolean; noDisposer?: boolean };
  /** 事件面是否提供: `true` (缺省) 提供 `on`, `false` 不给 `on`. */
  events?: boolean;
  /** 工具面是否提供: `true` (缺省) 提供 `tools`, `false` 不给 `tools`. */
  tools?: boolean;
}

/** 装配结果. */
export interface Assembled {
  engine: FakeEngine;
  events: FakeEvents;
  tools: FakeTools;
  /** `apply` 期间打到 stderr 的告警行 (去掉前缀与换行). */
  warnings: string[];
  /** 注册到的消费者 (通常 0 或 1 条). */
  consumers: ConsumerInputLike[];
  /** `apply` 的返回值; 注册面不返回注销函数时可能是 `undefined`. */
  dispose: (() => void) | undefined;
  /** 宿主侧派发一次会话事件: 找 `sources` 命中该节点的消费者调 `decide`; 无消费者返回 null. */
  fire(
    source: string,
    context?: Partial<SessionContext>,
  ): ConsumerOutput | null;
  /** 只调唯一注册消费者的 `decide` (没注册时直接失败). */
  decide(context?: Partial<SessionContext>): ConsumerOutput | null;
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
function createFakeEvents(): FakeEvents {
  const events: FakeEvents = {
    listeners: new Map(),
    on(event: string, listener: () => void): () => void {
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

/** 建一个假工具面. */
function createFakeTools(): FakeTools {
  const tools: FakeTools = {
    registered: [],
    registerTool(input: unknown): void {
      tools.registered.push(input);
    },
  };
  return tools;
}

/** 拼装本包的 `apply` 与宿主接线. */
export function assemble(options: AssembleOptions = {}): Assembled {
  const engine = createFakeEngine(options.engine ?? {});
  const events = createFakeEvents();
  const tools = createFakeTools();
  const expose = options.expose ?? "get";

  const ctx: Record<string, unknown> = {};
  if (expose === "get") {
    ctx["get"] = (service: string) =>
      service === "ruleEngine" ? engine : undefined;
  }
  if (expose === "direct") {
    ctx["ruleEngine"] = engine;
  }
  if (expose === "broken") {
    // 半装配: 服务对象在, 但没有 registerConsumer 方法
    ctx["ruleEngine"] = {};
  }
  if (options.events !== false) {
    ctx["on"] = events.on;
    ctx["emit"] = events.emit;
  }
  if (options.tools !== false) {
    ctx["tools"] = tools;
  }

  const warnings: string[] = [];
  let dispose: (() => void) | undefined;
  const raw = captureStderr(() => {
    dispose = apply(ctx, options.config);
  });
  for (const line of raw) {
    const text = line.trim();
    if (text.length > 0) warnings.push(text);
  }

  const decide = (
    context: Partial<SessionContext> = {},
  ): ConsumerOutput | null => {
    const [consumer] = engine.consumers;
    if (consumer === undefined) throw new Error("没有注册任何消费者");
    return consumer.decide({
      sessionId: context.sessionId ?? "session-1",
      turn: context.turn ?? 1,
      ...(context.text === undefined ? {} : { text: context.text }),
    });
  };

  return {
    engine,
    events,
    tools,
    warnings,
    consumers: engine.consumers,
    dispose,
    fire(source: string, context: Partial<SessionContext> = {}) {
      const consumer = engine.consumers.find((item) =>
        (item.sources ?? []).includes(source),
      );
      if (consumer === undefined) return null;
      return consumer.decide({
        sessionId: context.sessionId ?? "session-1",
        turn: context.turn ?? 1,
        ...(context.text === undefined ? {} : { text: context.text }),
      });
    },
    decide,
  };
}
