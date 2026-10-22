/**
 * fake-host.ts — 测试用最小宿主假件（不依赖 @deepseek-ai/*）。
 *
 * 只实现 tool-consult 用到的面：tools.register / restrict / schemas、agents.list、
 * ctx.get / on / effect / logger，以及一个手工 emit 的事件总线。遮罩限制用
 * `restrictCalls` 记录，便于断言「替换而非叠加」。
 */

/** 假工具 schema。 */
export interface FakeToolSchema {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** 注册进假宿主的工具定义。 */
export interface FakeToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute?: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>;
  output?: unknown;
}

/** 一次 restrict 调用记录。 */
export interface RestrictCall {
  allow: string[];
  disposed: boolean;
}

/** 假工具服务。 */
export interface FakeTools {
  schemas: () => FakeToolSchema[];
  register: (definition: FakeToolDefinition) => () => void;
  restrict: (filter: { allow?: string[]; deny?: string[] }) => () => void;
}

/** 假代理。 */
export interface FakeAgent {
  id: string;
  session: { id: string; header?: { origin?: string; delegationDepth?: number } };
  ctx: FakeCtx;
  /** 触发该代理作用域的事件（tools/pre-execute）。 */
  emit: (event: string, ...args: unknown[]) => unknown;
}

/** 假上下文。 */
export interface FakeCtx {
  get?: (service: string) => unknown;
  on?: (event: string, callback: (...args: unknown[]) => unknown) => unknown;
  effect?: (callback: () => (() => void) | void) => unknown;
  logger?: (namespace: string) => {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    debug?: (message: string) => void;
  };
  tools?: FakeTools;
}

/** 假宿主。 */
export interface FakeHost {
  ctx: FakeCtx;
  tools: FakeTools;
  agents: { list: () => FakeAgent[] };
  restrictCalls: RestrictCall[];
  registered: Map<string, FakeToolDefinition>;
  logs: Array<{ level: string; message: string }>;
  addAgent: (options?: { id?: string; header?: { origin?: string; delegationDepth?: number } }) => FakeAgent;
  emit: (event: string, ...args: unknown[]) => unknown;
  dispose: () => void;
  /** 当前生效的遮罩名单（最后一次未撤销的 restrict）。 */
  activeMask: () => string[] | undefined;
}

/**
 * 创建假宿主。
 * @param options.schemas 全局工具面。
 * @param options.withAgentTools 是否让 agent.ctx.tools 可用（false 模拟无作用域宿主）。
 * @param options.restrictFailure 前 N 次 restrict 抛指定错误（模拟名单失配等）。
 */
export function createFakeHost(options: {
  schemas: FakeToolSchema[];
  withAgentTools?: boolean;
  withToolsService?: boolean;
  restrictFailure?: { message: string; times: number };
}): FakeHost {
  const restrictCalls: RestrictCall[] = [];
  const registered = new Map<string, FakeToolDefinition>();
  const logs: Array<{ level: string; message: string }> = [];
  const globalHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const effects: Array<() => void> = [];
  const agentList: FakeAgent[] = [];
  const withAgentTools = options.withAgentTools !== false;

  const tools: FakeTools = {
    schemas: () => options.schemas.map((schema) => ({ ...schema })),
    register: (definition) => {
      registered.set(definition.name, definition);
      return () => {
        registered.delete(definition.name);
      };
    },
    restrict: (filter) => {
      const failure = options.restrictFailure;
      if (failure !== undefined && failure.times > 0) {
        failure.times -= 1;
        throw new Error(failure.message);
      }
      const call: RestrictCall = { allow: [...(filter.allow ?? [])], disposed: false };
      restrictCalls.push(call);
      return () => {
        call.disposed = true;
      };
    },
  };

  const makeCtx = (handlers: Map<string, Array<(...args: unknown[]) => unknown>>, includeTools: boolean): FakeCtx => ({
    get: (service) => service === "tools"
      ? (options.withToolsService === false ? undefined : tools)
      : service === "agents"
        ? { list: () => [...agentList] }
        : undefined,
    on: (event, callback) => {
      const list = handlers.get(event) ?? [];
      list.push(callback);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        const index = current.indexOf(callback);
        if (index >= 0) current.splice(index, 1);
      };
    },
    effect: (callback) => {
      const dispose = callback();
      if (typeof dispose === "function") effects.push(dispose);
      return dispose;
    },
    logger: () => ({
      info: (message: string) => logs.push({ level: "info", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
      debug: (message: string) => logs.push({ level: "debug", message }),
    }),
    ...(includeTools ? { tools } : {}),
  });

  const ctx = makeCtx(globalHandlers, withAgentTools);

  const emit = (event: string, ...args: unknown[]): unknown => {
    let result: unknown;
    for (const handler of globalHandlers.get(event) ?? []) result = handler(...args);
    return result;
  };

  const addAgent: FakeHost["addAgent"] = (agentOptions = {}) => {
    const id = agentOptions.id ?? `agent-${agentList.length + 1}`;
    const agentHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const agentCtx = makeCtx(agentHandlers, withAgentTools);
    const agent: FakeAgent = {
      id,
      session: { id, ...(agentOptions.header === undefined ? {} : { header: agentOptions.header }) },
      ctx: agentCtx,
      emit: (event, ...args) => {
        let result: unknown;
        for (const handler of agentHandlers.get(event) ?? []) result = handler(...args);
        return result;
      },
    };
    agentList.push(agent);
    return agent;
  };

  return {
    ctx,
    tools,
    agents: { list: () => [...agentList] },
    restrictCalls,
    registered,
    logs,
    addAgent,
    emit,
    dispose: () => {
      for (const dispose of effects.splice(0)) dispose();
    },
    activeMask: () => {
      const last = [...restrictCalls].reverse().find((call) => !call.disposed);
      return last?.allow;
    },
  };
}
