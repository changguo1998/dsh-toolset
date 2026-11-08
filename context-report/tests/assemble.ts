/**
 * 集成层装配器: 用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`.
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务）, 本文件不以 `.test.ts` 结尾,
 * 也不计入覆盖率（dev/coverage 只统 `src`）. 集成用例一律经本装配器接宿主, 不直接 import
 * 宿主运行时.
 *
 * 本包没有落盘面（报告只读投影与 token 读数）, 集成层不写临时目录.
 *
 * 投影注册表按宿主语义实现: `register` 收定义, `stateOf` 按会话惰性整段折叠并缓存
 * （对应宿主的 `cellFor` / `buildCell`）; 另可 `drive` 逐事件 eager 驱动, 与宿主每次提交
 * 事件后调用 `apply` 的路径同形.
 */

import {
  PROJECTION_KEY,
  STATS_KEY,
  apply,
  type ContextReportService,
  type HostSessionLike,
  type ProjectionDefLike,
  type ProjectionRegistryLike,
} from "../src/index.ts";
import type {
  ContextReport,
  ContextReportInput,
  ReportEvent,
  SessionStatsLike,
} from "../src/types.ts";
import { statsFixture, typicalSession } from "./helpers.ts";

/** 工具定义的最小结构面（`ctx.tools.register` 的入参形状）. */
export interface ToolDefLike {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
  };
  execute(args: unknown, exec: unknown): Promise<unknown>;
  output: {
    schema: unknown;
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

/** 假工具面: 收集注册定义, 按名取用. */
export interface ToolSurface {
  readonly defs: ToolDefLike[];
  names(): string[];
  require(name: string): ToolDefLike;
}

/** 假事件面: 记录订阅（本包不消费事件, 用零订阅做断言）. */
export interface EventSurface {
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): number;
  listenerCount(event?: string): number;
}

/** 假服务面: 宿主 `ctx.get` / `ctx.provide` 的替身（同名重复注册即抛错）. */
export interface ServiceSurface {
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  names(): string[];
}

/** 测试会话: 宿主 `Session` 的读面子集. */
export interface TestSession extends HostSessionLike {
  readonly id: string;
  readonly events: readonly ReportEvent[];
  readonly seq: number;
  requestHeader(): unknown;
}

/** 假投影注册表: 按会话缓存单元状态; 可另挂官方 `sessionStats` 视图. */
export interface FakeRegistry extends ProjectionRegistryLike {
  readonly defs: ProjectionDefLike[];
  /** 当前在册单元数. */
  registered: number;
  registerCalls: number;
  stateOfCalls: number;
  /** 新读面调用次数（`snapshot`）; 与 `stateOfCalls` 一起钉住「优先走 snapshot」. */
  snapshotCalls: number;
  /** 逐事件 eager 驱动一个会话（返回折叠后状态的引用）. */
  drive(session: TestSession): unknown;
  /** 已缓存单元状态（未折叠过为 undefined）. */
  cell(session: unknown): unknown;
}

/** 装配形态: 三个数据源与服务面的缺席组合. */
export interface AssembleOptions {
  /** 会话清单（缺省一个 `s1`, 事件为典型两回合会话）. */
  sessions?: TestSession[];
  /** 官方 `sessionStats` 视图, 按会话 id 给（缺省只有 `s1`）. */
  stats?: Record<string, SessionStatsLike>;
  /** token 计量服务; `"throw"` = 读数抛错, 缺省 = 挂载一个 canonical 读数. */
  tokenMeter?: { measure(session: unknown): unknown } | "throw";
  /** 是否挂载 tokenMeter（缺省挂载; `tokenMeter` 优先）. */
  withTokenMeter?: boolean;
  /** 插件配置. */
  config?: { detail?: string; projection?: boolean };
  withProjection?: boolean;
  withSessions?: boolean;
  withTools?: boolean;
  withProvide?: boolean;
  /** 是否挂日志面（缺省挂载）. */
  withLogger?: boolean;
  /** 投影注册抛错（宿主注册被拒）. */
  projectionRegisterThrows?: boolean;
  /** 本包投影读面抛错. */
  sessionContextThrows?: boolean;
  /** 官方 sessionStats 读面抛错. */
  statsThrows?: boolean;
  /** 工具注册抛错. */
  toolRegisterThrows?: boolean;
  /** provide 抛错. */
  provideThrows?: boolean;
}

/** 装配后的宿主句柄. */
export interface Assembled {
  readonly ctx: unknown;
  readonly sessions: TestSession[];
  readonly registry: FakeRegistry;
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  /** `[context-report] ...` 告警行. */
  readonly logs: string[];
  /** 取已注册工具（未注册即抛错）. */
  tool(): ToolDefLike;
  /** 取 `contextReport` 服务（未提供即抛错）. */
  service(): ContextReportService;
  /** 经服务面直接出报告. */
  report(options?: ContextReportInput): ContextReport;
  /** 经工具 `execute` 调一次（缺省无调用方会话）. */
  execute(args: unknown, exec?: unknown): Promise<unknown>;
  /** 经工具 `output.render` 投影一次. */
  render(value: unknown, args?: unknown): Array<{ type: string; text: string }>;
  /** 卸载本插件注册（幂等）. */
  dispose(): void;
}

/** 造一个测试会话（缺省带典型两回合事件与 deepseek/v4 请求头）. */
export function session(
  id: string,
  events: readonly ReportEvent[] = typicalSession(),
  header: unknown = { provider: "deepseek", model: "v4" },
): TestSession {
  return {
    id,
    events,
    seq: events.length,
    requestHeader: () => header,
  };
}

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

export function createEventSurface(): EventSurface {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (set === undefined) return 0;
      for (const listener of [...set]) listener(payload);
      return set.size;
    },
    listenerCount(event) {
      if (event !== undefined) return listeners.get(event)?.size ?? 0;
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

/** 假投影注册表（宿主 `SessionProjectionRegistry` 的结构子集）. */
function createRegistry(options: AssembleOptions): FakeRegistry {
  const defs: ProjectionDefLike[] = [];
  const cells = new Map<unknown, unknown>();
  const stats = options.stats ?? { s1: statsFixture() };
  const registry: FakeRegistry = {
    defs,
    registered: 0,
    registerCalls: 0,
    stateOfCalls: 0,
    snapshotCalls: 0,
    register(definition) {
      registry.registerCalls += 1;
      if (options.projectionRegisterThrows === true) {
        throw new Error("projection registry rejected");
      }
      defs.push(definition);
      registry.registered += 1;
      return () => {
        const index = defs.indexOf(definition);
        if (index >= 0) defs.splice(index, 1);
        registry.registered -= 1;
      };
    },
    snapshot(target, keys) {
      registry.snapshotCalls += 1;
      const key = keys?.[0];
      const values: Record<string, unknown> = {};
      const readStateOf = registry.stateOf;
      if (key !== undefined && readStateOf !== undefined) {
        const value = readStateOf.call(registry, target, key);
        if (value !== undefined) values[key] = value;
      }
      return { values };
    },
    stateOf(target, key) {
      registry.stateOfCalls += 1;
      if (key === STATS_KEY) {
        if (options.statsThrows === true) throw new Error("stats read failed");
        const id = (target as HostSessionLike | undefined)?.id;
        return id === undefined ? undefined : stats[id];
      }
      if (key !== PROJECTION_KEY) return undefined;
      if (options.sessionContextThrows === true) {
        throw new Error("sessionContext read failed");
      }
      return registry.drive(target as TestSession);
    },
    drive(target) {
      const existing = cells.get(target);
      if (existing !== undefined) return existing;
      const def = defs[0];
      if (def === undefined) return undefined;
      let state = def.init({}, 0);
      for (const event of target.events) state = def.apply(state, event);
      cells.set(target, state);
      return state;
    },
    cell(target) {
      return cells.get(target);
    },
  };
  return registry;
}

/** 装配 `apply`: 三个假面 + 日志记录 + 服务/provide 面. */
export function assemble(options: AssembleOptions = {}): Assembled {
  const sessions = options.sessions ?? [session("s1")];
  const registry = createRegistry(options);
  const events = createEventSurface();
  const services = createServiceSurface();
  const defs: ToolDefLike[] = [];
  const logs: string[] = [];

  const tokenMeter =
    options.tokenMeter === "throw"
      ? {
          measure: (): unknown => {
            throw new Error("meter failed");
          },
        }
      : (options.tokenMeter ??
        (options.withTokenMeter === false
          ? undefined
          : {
              measure: (): unknown => ({
                pressureTokens: 1_000,
                projectedTokens: 1_100,
                contextWindow: 8_000,
              }),
            }));

  const base: Record<string, unknown> = {
    get: (name: string): unknown => services.get(name),
    effect(fn: () => () => void): () => void {
      return fn();
    },
    on: (event: string, listener: (payload: unknown) => void): (() => void) =>
      events.on(event, listener),
  };
  if (options.withProjection !== false) base["sessionProjections"] = registry;
  if (options.withSessions !== false) {
    base["sessions"] = {
      list: (): readonly TestSession[] => sessions,
      get: (id: string): TestSession | undefined =>
        sessions.find((item) => item.id === id),
    };
  }
  if (options.withTools !== false) {
    base["tools"] = {
      register: (def: unknown): void => {
        if (options.toolRegisterThrows === true) {
          throw new Error("tool registry rejected");
        }
        defs.push(def as ToolDefLike);
      },
    };
  }
  if (tokenMeter !== undefined) base["tokenMeter"] = tokenMeter;

  // 说明: 代码读的是 `ctx.logger.info(...)`（对象形态）, 与 `BundleHost.logger?(ns)`
  // 的类型声明不一致; 集成层按代码实际读法提供, 该差异记在包追踪文档「偏差」.
  if (options.withLogger !== false) {
    base["logger"] = {
      info: (message: string): void => {
        logs.push(message);
      },
    };
  }

  const ctx: Record<string, unknown> = { ...base };
  if (options.withProvide !== false) {
    ctx["provide"] = (name: string, value: unknown): void => {
      if (options.provideThrows === true) {
        throw new Error("provide rejected");
      }
      services.provide(name, value);
    };
  }

  apply(ctx as never, options.config ?? {});

  const tools: ToolSurface = {
    defs,
    names: () => defs.map((def) => def.name),
    require(name) {
      const found = defs.find((def) => def.name === name);
      if (found === undefined) throw new Error(`未注册工具: ${name}`);
      return found;
    },
  };
  const tool = (): ToolDefLike => tools.require("context_report");
  const service = (): ContextReportService => {
    const value = services.get("contextReport");
    if (value === undefined) throw new Error("服务面 contextReport 未注册");
    return value as ContextReportService;
  };

  return {
    ctx,
    sessions,
    registry,
    tools,
    events,
    services,
    logs,
    tool,
    service,
    report: (input) => service().report(input),
    execute: (args, exec) => tool().execute(args, exec),
    render: (value, args) => tool().output.render(args ?? {}, value),
    dispose: () => {
      service().dispose();
    },
  };
}
