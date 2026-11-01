/**
 * 集成层装配器: 用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`。
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务）: 工具面记 `register` 与
 * `tools.guard` 的注册情况, 事件面记 `on` 订阅并可模拟 waterfall 调用, 服务面替身
 * `ctx.provide` / `ctx.get`（同名重复注册即抛错, 与 cordis 一致）。本文件不以
 * `.test.ts` 结尾, 也不计入覆盖率（dev/coverage 只统 `src`）。集成用例一律经本装配器
 * 接宿主, 不直接 import 宿主运行时。
 *
 * 本包对工具面是只读消费: 判定结果经 `tools.guard`（单调守卫, 返回字符串即拒绝）或
 * `tools/pre-execute`（waterfall 监听器, 返回 `{ kind: "deny", reason }`）交给宿主;
 * 本包不注册工具, 故工具面只断言"零注册"。
 */
import { apply } from "../src/index.ts";
import type {
  GuardHost,
  GuardService,
  PreExecuteExecution,
  PreToolDecision,
  SecurityGuardConfig,
} from "../src/index.ts";

/** 工具定义的最小结构面（`ctx.tools.register` 的入参形状；本包不注册）。 */
export interface ToolDefLike {
  name: string;
  description?: string;
  parameters?: unknown;
  execute?(args: unknown): Promise<unknown>;
}

/** 单调守卫的判定签名（宿主 `ctx.tools.guard`, 返回字符串即拒绝）。 */
export type GuardCheck = (exec: PreExecuteExecution) => string | undefined;

/** waterfall 监听器签名（宿主 `tools/pre-execute`）。 */
export type PreExecuteListener = (
  exec: PreExecuteExecution,
  next: () => PreToolDecision | Promise<PreToolDecision>,
) => PreToolDecision | Promise<PreToolDecision>;

/** 假工具面: 收集注册定义与单调守卫, 按名取用。 */
export interface ToolSurface {
  /** `ctx.tools.register` 收到的定义（本包应为空）。 */
  readonly defs: ToolDefLike[];
  /** `ctx.tools.guard` 收到的判定函数（未提供 `tools.guard` 面时为空）。 */
  readonly guards: GuardCheck[];
  names(): string[];
}

/** 假事件面: 记录 `on` 订阅, 支持模拟宿主 waterfall。 */
export interface EventSurface {
  /** 按注册顺序的监听器（扁平视图）。 */
  readonly listeners: PreExecuteListener[];
  on(event: string, listener: PreExecuteListener): () => void;
  /** 指定事件的订阅数（缺省统计全部）。 */
  listenerCount(event?: string): number;
  /** 模拟一次 pre-execute waterfall: 按注册顺序串联, 末端视为放行。 */
  run(exec: PreExecuteExecution): Promise<PreToolDecision>;
}

/** 假服务面: 宿主 `ctx.provide` / `ctx.get` 的替身。 */
export interface ServiceSurface {
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  names(): string[];
}

/** 装配形态: 完整宿主（含 provide） / 无 provide。 */
export type HostShape = "full" | "no-provide";

/** 装配选项。 */
export interface AssembleOptions {
  /** 是否提供宿主 `ctx.tools.guard` 单调守卫面（缺省 false = 走 waterfall 降级）。 */
  monotonic?: boolean;
  /** 装配形态（缺省 full）。 */
  shape?: HostShape;
  /** 传给 `apply` 的插件配置。 */
  config?: SecurityGuardConfig;
}

/** 装配后的宿主句柄。 */
export interface AssembledHost {
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  readonly logs: { info: string[]; warn: string[] };
  /** 装配时用的 ctx（`no-provide` 形态下不带 `provide`）。 */
  readonly ctx: unknown;
  /** 取服务面 `guard`; 未注册时抛错, 便于用例直接失败。 */
  guard(): GuardService;
  /** 统一判定入口: 有 `tools.guard` 走单调守卫, 否则走 waterfall。 */
  decide(exec: PreExecuteExecution): Promise<PreToolDecision>;
}

/** 建假服务面: 同名重复注册抛错（与 cordis 的 `provide` 一致）。 */
export function createServiceSurface(
  initial: Record<string, unknown> = {},
): ServiceSurface {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    provide(name, value) {
      if (values.has(name)) {
        throw new Error(`service "${name}" already registered`);
      }
      values.set(name, value);
    },
    get(name) {
      return values.get(name);
    },
    names() {
      return [...values.keys()];
    },
  };
}

/** 建假事件面: 只记 `on` 订阅并支持 waterfall 模拟。 */
export function createEventSurface(): EventSurface {
  const byEvent = new Map<string, PreExecuteListener[]>();
  const listeners: PreExecuteListener[] = [];
  return {
    listeners,
    on(event, listener) {
      const list = byEvent.get(event) ?? [];
      list.push(listener);
      byEvent.set(event, list);
      listeners.push(listener);
      return () => {
        for (const [name, bucket] of byEvent) {
          const at = bucket.indexOf(listener);
          if (at >= 0) bucket.splice(at, 1);
          if (bucket.length === 0) byEvent.delete(name);
        }
        const flat = listeners.indexOf(listener);
        if (flat >= 0) listeners.splice(flat, 1);
      };
    },
    listenerCount(event) {
      if (event !== undefined) return byEvent.get(event)?.length ?? 0;
      let total = 0;
      for (const list of byEvent.values()) total += list.length;
      return total;
    },
    async run(exec) {
      const chain = [...(byEvent.get("tools/pre-execute") ?? [])];
      const next = async (index: number): Promise<PreToolDecision> => {
        const listener = chain[index];
        return listener === undefined
          ? { kind: "allow" }
          : await listener(exec, () => next(index + 1));
      };
      return next(0);
    },
  };
}

/** 装配 `apply`: 三个假面 + 日志记录。 */
export function assemble(options: AssembleOptions = {}): AssembledHost {
  const shape = options.shape ?? "full";
  const services = createServiceSurface();
  const events = createEventSurface();
  const defs: ToolDefLike[] = [];
  const guards: GuardCheck[] = [];
  const logs = { info: [] as string[], warn: [] as string[] };

  const base = {
    get: (name: string): unknown => services.get(name),
    logger: (ns: string) => ({
      info: (message: string): void => {
        logs.info.push(`${ns}: ${message}`);
      },
      warn: (message: string): void => {
        logs.warn.push(`${ns}: ${message}`);
      },
    }),
    tools: {
      register: (def: unknown): void => {
        defs.push(def as ToolDefLike);
      },
      ...(options.monotonic === true
        ? {
            guard: (check: GuardCheck): unknown => {
              guards.push(check);
              return () => {
                const at = guards.indexOf(check);
                if (at >= 0) guards.splice(at, 1);
              };
            },
          }
        : {}),
    },
    on: (event: string, listener: PreExecuteListener): (() => void) =>
      events.on(event, listener),
  };

  const ctx: unknown =
    shape === "no-provide"
      ? base
      : {
          ...base,
          provide: (name: string, value: unknown): void => {
            services.provide(name, value);
          },
        };

  // 假面的 `tools` 形状随 `monotonic` 变化（无 `tools.guard` 面时故意不提供该键）,
  // 与宿主 `GuardHost` 的可选 `tools.guard` 在类型上不完全同形, 故此处断言一次即可。
  apply(ctx as GuardHost, options.config ?? {});

  const tools: ToolSurface = {
    defs,
    guards,
    names: () => defs.map((def) => def.name),
  };

  return {
    tools,
    events,
    services,
    logs,
    ctx,
    guard(): GuardService {
      const value = services.get("guard");
      if (value === undefined) throw new Error("服务面 guard 未注册");
      return value as GuardService;
    },
    async decide(exec) {
      if (options.monotonic === true) {
        const check = guards[0];
        if (check === undefined) throw new Error("单调守卫未注册");
        const receipt = check(exec);
        return receipt === undefined
          ? { kind: "allow" }
          : { kind: "deny", reason: receipt };
      }
      return events.run(exec);
    },
  };
}
