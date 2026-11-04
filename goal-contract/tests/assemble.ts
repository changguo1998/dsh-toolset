/**
 * 集成层装配器：用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`。
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务），本文件不以 `.test.ts`
 * 结尾，也不计入覆盖率（dev/coverage 只统 `src`）。集成用例一律经本装配器接宿主，
 * 不直接 import 宿主运行时。
 *
 * 服务取用顺序按 `goal-contract/src/index.ts` 的实现：`ctx.get("<name>")` 优先、直连属性回落。
 * 装配器用 `services` 选项切换这两种宿主形态，并额外提供「完全缺席」形态。
 */

import { apply } from "../src/index.ts";
import type {
  GoalsLike,
  GoalViewLike,
  HostAnswer,
  HostQuestion,
  UserQuestionsLike,
} from "../src/types.ts";

/** 工具定义的最小结构面（`ctx.tools.register` 的入参形状）。 */
export interface ToolDefLike {
  name: string;
  description: string;
  parameters: {
    type?: string;
    required?: string[];
    properties?: Record<string, unknown>;
  };
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  output: {
    schema: { type?: string; additionalProperties?: boolean };
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: unknown }>;
  };
}

/** 假工具面：收集注册定义，按名取用。 */
export interface ToolSurface {
  readonly defs: ToolDefLike[];
  names(): string[];
  require(name: string): ToolDefLike;
}

/** 假事件面：记录订阅（本包无事件消费者，用零订阅做断言）。 */
export interface EventSurface {
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): number;
  listenerCount(event?: string): number;
}

/** 假服务面：宿主 `ctx.get` 的替身。 */
export interface ServiceSurface {
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  names(): string[];
}

/** 工具面形态：正常注册 / 完全缺席 / register 抛错。 */
export type ToolsMode = "present" | "missing" | "throwing";

/** 服务面形态：经 ctx.get / 直连属性 / 完全缺席。 */
export type ServicesMode = "get" | "direct" | "none";

/** 装配选项。 */
export interface AssembleOptions {
  /** 工具面形态，缺省 present。 */
  tools?: ToolsMode;
  /** 服务面形态，缺省 get。 */
  services?: ServicesMode;
  /** 假 userQuestions 服务（`services` 为 none 时忽略）。 */
  userQuestions?: UserQuestionsLike;
  /** 假 goals 服务（`services` 为 none 时忽略）。 */
  goals?: GoalsLike;
}

/** 装配后的宿主句柄。 */
export interface AssembledHost {
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  /** `apply` 写到 stderr 的告警行（降级与注册失败两种）。 */
  readonly stderr: string[];
  /** 装配时用的 ctx。 */
  readonly ctx: unknown;
  /** 取唯一注册的工具；未注册时抛错，便于用例直接失败。 */
  tool(): ToolDefLike;
  /** 经注册的 `execute` 调用工具。 */
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  /** 经 `output.render` 投影工具返回值，返回第一个文本块。 */
  render(value: unknown): unknown;
}

/** 假 goals 落下的 `goal/change` 事件。 */
export interface GoalEvent {
  type: string;
  data: Record<string, unknown>;
}

/** 假 dsh-goal 句柄。 */
export interface GoalStore {
  readonly service: GoalsLike;
  readonly events: GoalEvent[];
  /** create 收到的请求（断言 maxGoalRounds 透传 / 缺省）。 */
  readonly requests: Array<{ objective: string; maxGoalRounds?: number }>;
  /** 最近一次创建出的 goal 视图。 */
  current(): GoalViewLike | undefined;
  /** 让 `get` 回读返回被篡改的 objective（模拟外部编辑）。 */
  tamper(objective: string | undefined): void;
}

/** 假 userQuestions 句柄。 */
export interface UserQuestionsStore {
  readonly service: UserQuestionsLike;
  /** 每轮 ask 提交的问题列表。 */
  readonly asked: HostQuestion[][];
  /** 每轮 ask 透传的执行上下文（agent / signal）。 */
  readonly contexts: Array<{
    agent?: unknown;
    signal?: { aborted: boolean };
  }>;
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

/** 临时替换 stderr.write，返回收集到的行。 */
export function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

/**
 * 假 dsh-goal：`create` 记录请求并落 `goal/change` 事件，`get` 回读当前视图。
 * `get: "missing"` 装配出不暴露 `get` 的服务（验证回落 create 返回值的分支）。
 */
export function createGoalStore(
  options: {
    createError?: Error;
    get?: "present" | "missing";
  } = {},
): GoalStore {
  const events: GoalEvent[] = [];
  const requests: Array<{ objective: string; maxGoalRounds?: number }> = [];
  let current: GoalViewLike | undefined;
  let tampered: string | undefined;
  const create: GoalsLike["create"] = (_agent, request) => {
    if (options.createError !== undefined) throw options.createError;
    requests.push({
      objective: request.objective,
      ...(request.maxGoalRounds === undefined
        ? {}
        : { maxGoalRounds: request.maxGoalRounds }),
    });
    current = {
      id: "goal-1",
      revision: 1,
      objective: request.objective,
      phase: "active",
      maxGoalRounds: request.maxGoalRounds ?? 256,
      roundsStarted: 0,
    };
    events.push({
      type: "goal/change",
      data: { op: "create", goal: current },
    });
    return current;
  };
  const get: GoalsLike["get"] = (_agent) => {
    if (current !== undefined && tampered !== undefined) {
      return { ...current, objective: tampered };
    }
    return current;
  };
  const service =
    options.get === "missing"
      ? ({ create } as unknown as GoalsLike)
      : ({ create, get } as GoalsLike);
  return {
    service,
    events,
    requests,
    current: () => current,
    tamper(objective) {
      tampered = objective;
    },
  };
}

/**
 * 假 userQuestions：按脚本顺序逐题应答；脚本用尽后重复最后一条。
 * `reject` 模拟 headless 无 answerer 的 `NO_PROVIDER`。
 */
export function createUserQuestions(
  scripts: HostAnswer[][] = [],
  options: { reject?: Error } = {},
): UserQuestionsStore {
  const asked: HostQuestion[][] = [];
  const contexts: Array<{ agent?: unknown; signal?: { aborted: boolean } }> =
    [];
  let call = 0;
  const service: UserQuestionsLike = {
    async ask(request) {
      asked.push(request.questions);
      contexts.push({
        ...(request.agent === undefined ? {} : { agent: request.agent }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (options.reject !== undefined) throw options.reject;
      const scripted = scripts[Math.min(call, scripts.length - 1)];
      call += 1;
      return { answers: [...(scripted ?? [])] };
    },
  };
  return { service, asked, contexts };
}

/** 装配 `apply`：三个假面 + stderr 收集。 */
export function assemble(options: AssembleOptions = {}): AssembledHost {
  const toolsMode = options.tools ?? "present";
  const servicesMode = options.services ?? "get";
  const services = createServiceSurface();
  const exposed =
    servicesMode === "none"
      ? {}
      : {
          ...(options.userQuestions === undefined
            ? {}
            : { userQuestions: options.userQuestions }),
          ...(options.goals === undefined ? {} : { goals: options.goals }),
        };
  for (const [name, value] of Object.entries(exposed)) {
    services.provide(name, value);
  }
  const events = createEventSurface();
  const defs: ToolDefLike[] = [];

  const base: Record<string, unknown> = {
    on: (event: string, listener: (payload: unknown) => void): (() => void) =>
      events.on(event, listener),
  };
  if (servicesMode === "get") {
    base["get"] = (name: string): unknown => services.get(name);
  }
  if (servicesMode === "direct") {
    Object.assign(base, exposed);
  }
  if (toolsMode === "present") {
    base["tools"] = {
      register: (def: unknown): void => {
        defs.push(def as ToolDefLike);
      },
    };
  } else if (toolsMode === "throwing") {
    base["tools"] = {
      register: (): void => {
        throw new Error("tools.register 拒绝注册");
      },
    };
  }
  const ctx: unknown = base;

  const stderr = captureStderr(() => apply(ctx));

  const tools: ToolSurface = {
    defs,
    names: () => defs.map((def) => def.name),
    require(name) {
      const found = defs.find((def) => def.name === name);
      if (found === undefined) throw new Error(`未注册工具：${name}`);
      return found;
    },
  };

  return {
    tools,
    events,
    services,
    stderr,
    ctx,
    tool() {
      return tools.require("goal_contract_draft");
    },
    execute(args, exec) {
      return tools.require("goal_contract_draft").execute(args, exec);
    },
    render(value) {
      return tools.require("goal_contract_draft").output.render({}, value)[0]
        ?.text;
    },
  };
}
