/**
 * 集成层装配器: 假工具面 + 假事件面 + 假服务面, 拼出本插件 `apply` 的宿主接线。
 *
 * 三个假面的形状照 `rule-engine/src/index.ts` 的结构面声明抄 (结构化类型, 不 import 宿主实现):
 * - 工具面: `tools.register(def)` 记下工具定义, 另给 `call` / `render` 两个调用入口, 等价宿主
 *   把工具交给模型后回传的 `execute` 与 `output.render` 投影;
 * - 事件面: `on(event, listener)` 记下监听器, 给 `emitSessionEvent` / `emitCreated` /
 *   `emitPreExecute` 三个派发入口, 其中 `emitPreExecute` 按宿主 waterfall 语义串监听器;
 * - 服务面: `provide(name, value)` 记账, `ctx.get(name)` 返回宿主注入的 tools /
 *   sessionProjections / clock 面, 与 `agents` / `sessions` 两个 inject 硬依赖一起构成接线。
 *
 * 状态目录在系统临时目录下新建, 由 `dispose()` 删除; 注入走假 clock 的 `setTimeout`,
 * `dispose()` 一并撤销未触发的排期。告警从 stderr 抓取 (本插件装配期自证行也在其中)。
 *
 * 本装配器不以 `.test.ts` 结尾, 不参与覆盖率统计 (只统计 `src`)。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  apply,
  type Config,
  type ConsumerRegistration,
  type RuleEngineService,
  type ToolDef,
} from "../src/index.ts";

/** 一次注入: 送达路径 + 投影后的宿主消息。 */
export interface Delivery {
  via: "followup" | "steer" | "inject";
  message: Record<string, unknown>;
}

/** 假工具面: 注册记录 + execute 调用 + render 投影。 */
export interface ToolsFace {
  /** 按注册顺序记下的工具定义。 */
  readonly defs: readonly ToolDef[];
  /** 注册的工具名 (按注册顺序)。 */
  names(): string[];
  /** 取一个工具定义 (不存在时抛错, 便于用例暴露注册缺口)。 */
  def(name: string): ToolDef;
  /** 调一次工具的 `execute` (等价宿主执行工具调用)。 */
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** 调一次工具的 `output.render` (等价 TUI 把工具结果投影成文本块)。 */
  render(name: string, args?: unknown, value?: unknown): unknown[];
}

/** 假事件面: 三个宿主派发入口。 */
export interface EventFace {
  /** 按事件名统计监听器条数 (`session/event` / `session/created` / `tools/pre-execute`)。 */
  listenerCount(event: string): number;
  /** 派发一条会话事件 (`session/event`)。 */
  emitSessionEvent(event: unknown, session?: unknown): void;
  /** 派发会话建立 (`session/created`)。 */
  emitCreated(session?: unknown): void;
  /** 按 waterfall 语义派发工具执行前拦截点, 返回最终裁决。 */
  emitPreExecute(exec: unknown): Promise<unknown>;
}

/** 装配选项。 */
export interface AssembleOptions {
  /** 工具面: 正常注册 (缺省) / 缺席 / 注册抛错。 */
  tools?: "face" | "absent" | "throwing";
  /** 服务面: 正常 provide (缺省) / 缺席 (ctx 无 provide) / provide 抛错。 */
  provide?: "face" | "absent" | "throwing";
  /** `ctx.get` 整体抛错 (cordis 严格模式)。 */
  strictGet?: boolean;
  /** 宿主 clock 面: 提供假 clock (缺省) / 缺席 (走进程内回落)。 */
  clock?: boolean;
  /** 宿主会话 id (缺省 `s1`)。 */
  sessionId?: string;
  /** 会话可见投影 (`deriveMessages()` 的返回值)。 */
  messages?: readonly unknown[];
  /** 会话 inbox 投影 (`sessionProjections.stateOf(session, "inbox")`)。 */
  inbox?: { "next-step": unknown[]; "next-turn": unknown[] };
}

/** 装配体。 */
export interface Assembly {
  readonly tools: ToolsFace;
  readonly events: EventFace;
  /** `ctx.provide` 记下的服务 (名 → 值)。 */
  readonly provided: ReadonlyMap<string, unknown>;
  /** 装配期写入 stderr 的告警行 (含 `[rule-engine] warn:` 前缀)。 */
  readonly warnings: readonly string[];
  /** 状态目录 (临时目录, `dispose()` 删除)。 */
  readonly stateDir: string;
  /** 已送达的注入 (按送达顺序)。 */
  readonly delivered: readonly Delivery[];
  /** 已 flush 的会话句柄 (按送达顺序)。 */
  readonly flushed: readonly unknown[];
  /** 取 `ruleEngine` 服务 (服务缺席时 `undefined`)。 */
  service(): RuleEngineService | undefined;
  /** 读状态文件原文 (`rules.json`; 未落盘时 `undefined`)。 */
  readStateFile(): unknown;
  /** 删除临时目录并撤销未触发的注入排期。 */
  dispose(): void;
}

/** 捕获一段代码里写 stderr 的分片 (结束后恢复原函数)。 */
function captureStderr(run: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return run()
    .catch(() => {})
    .then(() => chunks)
    .finally(() => {
      process.stderr.write = original;
    });
}

/** 拼装 `apply` 与宿主接线 (返回后再派发事件, 与宿主装载顺序一致)。 */
export async function assemble(
  config?: Config,
  options: AssembleOptions = {},
): Promise<Assembly> {
  const sessionId = options.sessionId ?? "s1";
  const stateDir = mkdtempSync(path.join(tmpdir(), "rule-engine-integration-"));
  const defs: ToolDef[] = [];
  const provided = new Map<string, unknown>();
  const listeners = new Map<string, unknown[]>();
  const delivered: Delivery[] = [];
  const flushed: unknown[] = [];
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  const followup = (message: unknown): void => {
    delivered.push({ via: "followup", message: asRecord(message) });
  };
  const steer = (message: unknown): void => {
    delivered.push({ via: "steer", message: asRecord(message) });
  };
  const inject = (message: unknown): void => {
    delivered.push({ via: "inject", message: asRecord(message) });
  };
  const agent = { session: { id: sessionId }, followup, steer, inject };
  const inbox = options.inbox ?? { "next-step": [], "next-turn": [] };
  const session = {
    id: sessionId,
    deriveMessages: (): readonly unknown[] => options.messages ?? [],
  };

  const schedule = (delayMs: number, callback: () => void): (() => void) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      callback();
    }, delayMs);
    pendingTimers.add(timer);
    return () => {
      pendingTimers.delete(timer);
      clearTimeout(timer);
    };
  };
  const timers = {
    now: () => Date.now(),
    schedule,
    interval: (delayMs: number, callback: () => void): (() => void) => {
      const timer = setInterval(callback, delayMs);
      return () => clearInterval(timer);
    },
  };
  const clock = {
    now: () => Date.now(),
    scope: () => timers,
  };

  const registrar = {
    register: (def: unknown): void => {
      if (options.tools === "throwing") throw new Error("register boom");
      defs.push(def as ToolDef);
    },
  };

  const get = (name: string): unknown => {
    if (options.strictGet === true) throw new Error("strict mode boom");
    if (name === "tools") {
      return options.tools === "absent" ? undefined : registrar;
    }
    if (name === "sessionProjections") {
      return {
        stateOf: (_session: unknown, key: string): unknown =>
          key === "inbox" ? inbox : undefined,
      };
    }
    if (name === "clock") {
      return options.clock === false ? undefined : clock;
    }
    return undefined;
  };

  const on = (event: string, listener: unknown): void => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
  };

  const ctx: Record<string, unknown> = {
    on,
    get,
    agents: { get: (id: string) => (id === sessionId ? agent : undefined) },
    sessions: {
      flush: (handle: unknown) => {
        flushed.push(handle);
        return Promise.resolve();
      },
      get: (id: string) => (id === sessionId ? session : undefined),
    },
  };
  if (options.provide !== "absent") {
    ctx["provide"] = (serviceName: string, value: unknown): void => {
      if (options.provide === "throwing") throw new Error("provide boom");
      provided.set(serviceName, value);
    };
  }

  const chunks = await captureStderr(async () => {
    await apply(ctx, { ...config, stateDir });
  });
  const warnings = chunks
    .join("")
    .split("\n")
    .filter((line) => line.includes("[rule-engine] warn:"));

  const tools: ToolsFace = {
    defs,
    names: () => defs.map((def) => def.name),
    def(name: string): ToolDef {
      const found = defs.find((def) => def.name === name);
      if (found === undefined) throw new Error(`工具未注册: ${name}`);
      return found;
    },
    call: async (name, args = {}) => tools.def(name).execute(args),
    render: (name, args, value) => tools.def(name).output.render(args, value),
  };

  const events: EventFace = {
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    emitSessionEvent(event, sessionLike = { id: sessionId }) {
      for (const listener of listeners.get("session/event") ?? []) {
        (listener as (s: unknown, e: unknown) => void)(sessionLike, event);
      }
    },
    emitCreated(sessionLike = { id: sessionId }) {
      for (const listener of listeners.get("session/created") ?? []) {
        (listener as (s: unknown) => void)(sessionLike);
      }
    },
    async emitPreExecute(exec) {
      const chain = listeners.get("tools/pre-execute") ?? [];
      const step = async (index: number): Promise<unknown> => {
        const listener = chain[index] as
          ((e: unknown, next: () => Promise<unknown>) => unknown) | undefined;
        if (listener === undefined) return { kind: "allow" };
        return await listener(exec, () => step(index + 1));
      };
      return await step(0);
    },
  };

  return {
    tools,
    events,
    provided,
    warnings,
    stateDir,
    delivered,
    flushed,
    service: () => provided.get("ruleEngine") as RuleEngineService | undefined,
    readStateFile(): unknown {
      try {
        return JSON.parse(
          readFileSync(path.join(stateDir, "rules.json"), "utf8"),
        );
      } catch {
        return undefined;
      }
    },
    dispose(): void {
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** 等一轮宏任务 + 微任务 (注入被推迟一个宏任务)。 */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** 注入消息的正文 (取自 `content[0].text`)。 */
export function messageText(message: Record<string, unknown>): string {
  const content = message["content"] as
    { type?: string; text?: string }[] | undefined;
  return content?.[0]?.text ?? "";
}

/** 只取本引擎注入 (按送达路径过滤)。 */
export function deliveriesVia(
  assembly: Assembly,
  via: Delivery["via"],
): Delivery[] {
  return assembly.delivered.filter((delivery) => delivery.via === via);
}

/** 消费者的最小注册入口 (服务面); 服务缺席时抛错。 */
export function registerConsumer(
  assembly: Assembly,
  registration: ConsumerRegistration,
): () => void {
  const service = assembly.service();
  if (service === undefined) throw new Error("ruleEngine 服务缺席");
  return service.registerConsumer(registration);
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value !== null && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
}
