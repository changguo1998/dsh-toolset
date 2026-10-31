/**
 * 集成层装配器: 用假工具面 / 假事件面 / 假日志面拼出本包的 `apply` 与宿主接线.
 *
 * 三个假面的形状 (与总规范 4.2 一致):
 * - 假工具面: `tools/post-execute` 的 waterfall —— 本包不注册任何工具, 只作为一位消费者挂在
 *   该节点上; 装配器按注册顺序链式派发, `next` 走到下一位消费者, 都走完落到宿主兜底,
 *   据此验证本包「先拿下游决定, 再决定是否追加附加上下文」的时序;
 * - 假事件面: `ctx.on` 保存监听器并记录 `prepend` 选项, 返回值按注册顺序注销;
 * - 假日志面: `ctx.logger.warn` 记录告警, 不落到 stderr (另留 `stderr` 捕获兜底路径).
 *
 * 只装配与派发, 不放断言; 断言在 `tests/integration/*.test.ts`.
 */

import type { Config } from "../src/index.ts";
import { apply } from "../src/index.ts";

/** 宿主 `tools/post-execute` 事件名. */
export const POST_EXECUTE = "tools/post-execute";

/** 工具调用面 (宿主 `ToolExecution` 的结构子集). */
export interface ExecLike {
  name?: string;
  arguments?: unknown;
  callId?: string;
}

/** 工具结果面 (宿主 `ToolExecutionResult` 的结构子集). */
export interface ResultLike {
  content?: unknown;
  value?: unknown;
  isError?: boolean;
  error?: unknown;
}

/** 下游决定 (`PostToolDecision` 的结构子集). */
export interface DecisionLike {
  kind?: string;
  additionalContexts?: unknown[];
  [key: string]: unknown;
}

/** `tools/post-execute` 的一位消费者. */
export type PostExecuteHandler = (
  exec: ExecLike | undefined,
  result: ResultLike | undefined,
  next: () => Promise<unknown>,
) => unknown;

/** 假事件面: 记监听器与订阅选项, 支持派发与注销. */
export interface FakeEvents {
  /** 事件名 → 监听器 (按实际调用顺序). */
  listeners: Map<string, PostExecuteHandler[]>;
  /** 每次 `ctx.on` 的入参记录. */
  subscriptions: Array<{ event: string; prepend: boolean }>;
  on(
    event: string,
    handler: PostExecuteHandler,
    options?: { prepend?: boolean },
  ): unknown;
  /** 某事件当前的监听器数. */
  count(event?: string): number;
}

/** 装配选项. */
export interface AssembleOptions {
  config?: Config;
  /** 事件面形态: `ok` (缺省) 正常订阅, `missing` 不给 `ctx.on`, `noDisposer` 订阅后不返回注销函数, `throw` 让 `ctx.on` 抛错. */
  events?: "ok" | "missing" | "noDisposer" | "throw";
  /** 是否提供 `ctx.logger.warn` (缺省提供). */
  logger?: boolean;
}

/** 装配结果. */
export interface Assembled {
  events: FakeEvents;
  /** 走 `ctx.logger.warn` 的告警 (去掉本包前缀). */
  loggerWarnings: string[];
  /** `apply` 期间打到 stderr 的告警行 (stderr 兜底路径). */
  stderr: string[];
  /** 注册到的 `tools/post-execute` 监听器数 (实时值, 注销后归零). */
  readonly handlerCount: number;
  /** `apply` 的返回值 (注销函数). */
  dispose: () => void;
  /** 宿主侧派发一次 `tools/post-execute`: 从本包这位消费者起沿 waterfall 往下走. */
  postExecute(
    exec: ExecLike | undefined,
    result: ResultLike | undefined,
    host?: () => DecisionLike | undefined | Promise<DecisionLike | undefined>,
  ): Promise<unknown>;
}

/** 捕获 stderr 跑一段代码 (结束后恢复), 返回写入的片段. */
function captureStderr(run: () => void): string[] {
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

/** 建一个假事件面; `mode` 决定 `on` 的返回与抛错行为. */
function createFakeEvents(mode: "ok" | "noDisposer" | "throw"): FakeEvents {
  const events: FakeEvents = {
    listeners: new Map(),
    subscriptions: [],
    on(
      event: string,
      handler: PostExecuteHandler,
      options?: { prepend?: boolean },
    ): unknown {
      if (mode === "throw") throw new Error(`没有该事件: ${event}`);
      events.subscriptions.push({ event, prepend: options?.prepend === true });
      const list = events.listeners.get(event) ?? [];
      // `prepend: true` 排在已有消费者之前 (宿主 waterfall 的插入语义)
      if (options?.prepend === true) list.unshift(handler);
      else list.push(handler);
      events.listeners.set(event, list);
      if (mode === "noDisposer") return undefined;
      return () => {
        const current = events.listeners.get(event) ?? [];
        events.listeners.set(
          event,
          current.filter((item) => item !== handler),
        );
      };
    },
    count(event: string = POST_EXECUTE): number {
      return (events.listeners.get(event) ?? []).length;
    },
  };
  return events;
}

/** 拼装本包的 `apply` 与宿主接线. */
export function assemble(options: AssembleOptions = {}): Assembled {
  const mode = options.events ?? "ok";
  const events = createFakeEvents(
    mode === "noDisposer" ? "noDisposer" : mode === "throw" ? "throw" : "ok",
  );
  const loggerWarnings: string[] = [];

  const ctx: Record<string, unknown> = {};
  if (mode !== "missing") ctx["on"] = events.on;
  if (options.logger !== false) {
    ctx["logger"] = {
      warn: (message: string): void => {
        loggerWarnings.push(
          message.replace(/^\[escalation-hint\]\s*/, "").trim(),
        );
      },
    };
  }

  let dispose: () => void = () => {};
  const stderr = captureStderr(() => {
    dispose = apply(ctx, options.config);
  });

  /** 从本包监听的这位消费者起往下走; `next` 走到下一位, 都走完落到宿主兜底. */
  const postExecute = async (
    exec: ExecLike | undefined,
    result: ResultLike | undefined,
    host?: () => DecisionLike | undefined | Promise<DecisionLike | undefined>,
  ): Promise<unknown> => {
    const list = [...(events.listeners.get(POST_EXECUTE) ?? [])];
    const run = async (index: number): Promise<unknown> => {
      const handler = list[index];
      if (handler === undefined) {
        return host === undefined ? undefined : await host();
      }
      return await handler(exec, result, () => run(index + 1));
    };
    return run(0);
  };

  return {
    events,
    loggerWarnings,
    stderr: stderr.map((line) => line.trim()).filter((line) => line.length > 0),
    get handlerCount(): number {
      return events.count();
    },
    dispose,
    postExecute,
  };
}

/** 从决定里取出注入的附加上下文 (没有则空数组). */
export function contextsOf(decision: unknown): Array<Record<string, unknown>> {
  const record = decision as DecisionLike | undefined;
  const list = record?.additionalContexts;
  if (!Array.isArray(list)) return [];
  return list.map((item) => item as Record<string, unknown>);
}

/** 从一条附加上下文里取出正文文本 (不是标准形状时返回空串). */
export function textOf(message: Record<string, unknown>): string {
  const content = message["content"];
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = block as Record<string, unknown> | null;
      const text = record === null ? undefined : record["text"];
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}
