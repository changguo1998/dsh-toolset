/**
 * fake-host.ts — 测试用最小宿主假件（不依赖 @deepseek-ai/*）。
 *
 * 覆盖新机制用到的面: 全局定义枚举 / 条件工具判定 / 每代理作用域 shadow /
 * 每代理 deny / `schemas` 投影 / `tools/change` 广播 / pinNotes hold。
 *
 * 对齐真实宿主的几个行为:
 * - 作用域注册按名覆盖全局, 且自身层豁免 restrict；
 * - `definitions()` 返回 shadow 前的全局完整定义；
 * - `executable(name)` 对带 `when` 的注册返回 undefined；
 * - restrict / register / 撤销同步广播 `tools/change`。
 */

/** 假工具 schema（模型面投影）。 */
export interface FakeToolSchema {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** 假输出声明。 */
export interface FakeToolOutput {
  schema: Record<string, unknown>;
  render: (
    args: unknown,
    value: unknown,
  ) => Array<{ type: string; text: string }>;
}

/** 注册进假宿主的工具定义。 */
export interface FakeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec?: unknown) => Promise<unknown> | unknown;
  output: FakeToolOutput;
  timeoutMs?: number;
  deferLoading?: boolean;
  /** 条件注册；存在即视为条件工具。 */
  when?: (context: unknown) => boolean | Promise<boolean>;
}

/** 一次 restrict 调用记录。 */
export interface RestrictCall {
  allow: string[];
  deny: string[];
  disposed: boolean;
  /** 施加作用域的代理 id（空串表示全局作用域）。 */
  agentId: string;
}

/** 假工具服务。 */
export interface FakeTools {
  schemas: (scope?: unknown) => FakeToolSchema[] | undefined;
  register: (definition: FakeToolDefinition) => () => void;
  restrict: (filter: { allow?: string[]; deny?: string[] }) => () => void;
  definitions: (scope?: unknown) => readonly FakeToolDefinition[];
  get: (name: string, scope?: unknown) => FakeToolDefinition | undefined;
  executable: (name: string, scope?: unknown) => FakeToolDefinition | undefined;
}

/** 假代理。 */
export interface FakeAgent {
  id: string;
  session: {
    id: string;
    header?: { origin?: string; delegationDepth?: number };
  };
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

/** 假 pinNotes。 */
export interface FakePinNotes {
  hold(
    key: string,
    provider: (context: { sessionId: string }) => string | undefined,
  ): () => void;
  /** 当前登记的全部 key（按登记顺序）。 */
  keys(): string[];
  /** 按 key + 会话取投递正文。 */
  text(key: string, sessionId: string): string | undefined;
}

/** 假宿主。 */
export interface FakeHost {
  ctx: FakeCtx;
  tools: FakeTools;
  agents: { list: () => FakeAgent[] };
  restrictCalls: RestrictCall[];
  registered: Map<string, FakeToolDefinition>;
  /** 作用域 shadow（agent id → 工具名 → 定义）。 */
  scoped: Map<string, Map<string, FakeToolDefinition>>;
  pinNotes: FakePinNotes;
  logs: Array<{ level: string; message: string }>;
  addAgent: (options?: {
    id?: string;
    header?: { origin?: string; delegationDepth?: number };
  }) => FakeAgent;
  /** 向全局工具面追加一个完整定义。 */
  addDefinition: (definition: FakeToolDefinition) => void;
  /** 便捷版：按名字与说明造一个无条件工具。 */
  addSchema: (schema: FakeToolSchema) => void;
  /** 覆盖个别服务返回值。 */
  setService: (name: string, value: unknown) => void;
  /** 让作用域视图临时缺掉这些名字。 */
  setHiddenVisible: (names: string[]) => void;
  /** 让 schemas(agent) 总是保留这些名字（模拟 deny 残留）。 */
  setResidual: (names: string[]) => void;
  /** 全局事件面的订阅数（不传事件名时统计总数）。 */
  listenerCount: (event?: string) => number;
  emit: (event: string, ...args: unknown[]) => unknown;
  dispose: () => void;
  /** 让下一次 restrict 抛错（模拟 tools/change 重算失败）。 */
  failNextRestrict: (message?: string) => void;
  /** 当前生效的 deny 名单（最后一次未撤销的 restrict）。 */
  activeDeny: (agentId?: string) => string[] | undefined;
}

/** 造一个完整工具定义（测试便捷）。 */
export function makeDefinition(
  name: string,
  options: Partial<Omit<FakeToolDefinition, "name">> = {},
): FakeToolDefinition {
  return {
    name,
    description: options.description ?? `${name} 工具: 用于 ${name} 场景。`,
    parameters: options.parameters ?? {
      type: "object",
      properties: { action: { type: "string" } },
    },
    execute: options.execute ?? (() => ({ ok: true })),
    output: options.output ?? {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.deferLoading === undefined
      ? {}
      : { deferLoading: options.deferLoading }),
    ...(options.when === undefined ? {} : { when: options.when }),
  };
}

/**
 * 创建假宿主。
 * @param options.definitions 全局完整定义。
 * @param options.withAgentTools 是否让 agent.ctx.tools 可用（false 模拟无作用域宿主）。
 * @param options.withToolsService `ctx.get("tools")` 是否返回工具服务。
 * @param options.withAgentsService `ctx.get("agents")` 是否返回代理注册表。
 * @param options.serviceValues 覆盖个别服务的返回值。
 * @param options.restrictFailure 前 N 次 restrict 抛指定错误。
 * @param options.registerFailure 前 N 次 register 抛指定错误。
 * @param options.emitOnRestrict restrict / 撤销时同步广播 tools/change。
 * @param options.schemaViewUndefined schemas(scope) 返回 undefined。
 * @param options.residualNames schemas(agent) 总是保留这些名字。
 * @param options.withEffect 是否提供 `ctx.effect`。
 * @param options.withLogger 是否提供 `ctx.logger`。
 * @param options.agentEvents 代理作用域是否提供 `ctx.on`。
 */
export function createFakeHost(options: {
  definitions: FakeToolDefinition[];
  withAgentTools?: boolean;
  withToolsService?: boolean;
  withAgentsService?: boolean;
  serviceValues?: Record<string, unknown>;
  restrictFailure?: { message: string; times: number };
  registerFailure?: { message: string; times: number };
  emitOnRestrict?: boolean;
  schemaViewUndefined?: boolean;
  residualNames?: readonly string[];
  withEffect?: boolean;
  withLogger?: boolean;
  loggerThrows?: boolean;
  loggerPartial?: boolean;
  agentEvents?: boolean;
  listenerDisposeThrows?: boolean;
  disposeThrows?: boolean;
}): FakeHost {
  const agentEvents = options.agentEvents !== false;
  const hiddenVisible = new Set<string>();
  const residualNames = new Set(options.residualNames ?? []);
  const restrictCalls: RestrictCall[] = [];
  const restrictions: Array<{
    agentId: string;
    allow: Set<string> | undefined;
    deny: Set<string> | undefined;
    disposed: boolean;
  }> = [];
  const registered = new Map<string, FakeToolDefinition>();
  const scoped = new Map<string, Map<string, FakeToolDefinition>>();
  const logs: Array<{ level: string; message: string }> = [];
  const globalHandlers = new Map<
    string,
    Array<(...args: unknown[]) => unknown>
  >();
  const effects: Array<() => void> = [];
  const agentList: FakeAgent[] = [];
  const withAgentTools = options.withAgentTools !== false;
  const serviceValues: Record<string, unknown> = { ...options.serviceValues };

  const globalDefinition = (name: string): FakeToolDefinition | undefined =>
    options.definitions.find((definition) => definition.name === name);

  const shadowOf = (
    agentId: string,
    name: string,
  ): FakeToolDefinition | undefined => scoped.get(agentId)?.get(name);

  /** 某作用域看到的工具面（全局减去 deny, 再加上自身层 shadow）。 */
  const visibleSchemas = (scope?: unknown): FakeToolSchema[] | undefined => {
    const agentId = (scope as { id?: unknown } | undefined)?.id;
    if (options.schemaViewUndefined === true && typeof agentId === "string")
      return undefined;
    const visible = new Map<string, FakeToolDefinition>();
    for (const definition of options.definitions) {
      if (hiddenVisible.has(definition.name)) continue;
      if (typeof agentId === "string") {
        const own = shadowOf(agentId, definition.name);
        if (own !== undefined) {
          visible.set(own.name, own);
          continue;
        }
      }
      let admitted = true;
      for (const restriction of restrictions) {
        if (restriction.disposed) continue;
        if (
          restriction.agentId !== "" &&
          restriction.agentId !== String(agentId)
        )
          continue;
        if (
          restriction.allow !== undefined &&
          !restriction.allow.has(definition.name)
        )
          admitted = false;
        if (
          restriction.deny !== undefined &&
          restriction.deny.has(definition.name)
        )
          admitted = false;
      }
      if (admitted) visible.set(definition.name, definition);
    }
    if (typeof agentId === "string") {
      for (const definition of scoped.get(agentId)?.values() ?? []) {
        visible.set(definition.name, definition);
      }
      for (const name of residualNames) {
        const definition = globalDefinition(name);
        if (definition !== undefined) visible.set(name, definition);
      }
    }
    return [...visible.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }));
  };

  const emit = (event: string, ...args: unknown[]): unknown => {
    let result: unknown;
    for (const handler of globalHandlers.get(event) ?? [])
      result = handler(...args);
    return result;
  };

  const notify = (): void => {
    if (options.emitOnRestrict === true) emit("tools/change");
  };

  const registerScoped = (
    agentId: string,
    definition: FakeToolDefinition,
  ): (() => void) => {
    const failure = options.registerFailure;
    if (failure !== undefined && failure.times > 0) {
      failure.times -= 1;
      throw new Error(failure.message);
    }
    if (agentId === "") {
      registered.set(definition.name, definition);
    } else {
      const own = scoped.get(agentId) ?? new Map<string, FakeToolDefinition>();
      own.set(definition.name, definition);
      scoped.set(agentId, own);
    }
    notify();
    return () => {
      if (agentId === "") registered.delete(definition.name);
      else scoped.get(agentId)?.delete(definition.name);
      notify();
      if (options.disposeThrows === true) throw new Error("tool disposed");
    };
  };

  const restrictFor = (
    agentId: string,
    filter: { allow?: string[]; deny?: string[] },
  ): (() => void) => {
    const failure = options.restrictFailure;
    if (failure !== undefined && failure.times > 0) {
      failure.times -= 1;
      throw new Error(failure.message);
    }
    const call: RestrictCall = {
      allow: [...(filter.allow ?? [])],
      deny: [...(filter.deny ?? [])],
      disposed: false,
      agentId,
    };
    restrictCalls.push(call);
    const restriction = {
      agentId,
      allow: filter.allow === undefined ? undefined : new Set(filter.allow),
      deny: filter.deny === undefined ? undefined : new Set(filter.deny),
      disposed: false,
    };
    restrictions.push(restriction);
    notify();
    return () => {
      call.disposed = true;
      restriction.disposed = true;
      notify();
      if (options.disposeThrows === true) throw new Error("layer disposed");
    };
  };

  const tools: FakeTools = {
    schemas: (scope) => visibleSchemas(scope),
    register: (definition) => registerScoped("", definition),
    restrict: (filter) => restrictFor("", filter),
    definitions: () => [...options.definitions],
    get: (name, scope) => {
      const agentId = (scope as { id?: string } | undefined)?.id;
      return (
        (typeof agentId === "string" ? shadowOf(agentId, name) : undefined) ??
        globalDefinition(name)
      );
    },
    executable: (name, scope) => {
      const agentId = (scope as { id?: string } | undefined)?.id;
      const definition =
        (typeof agentId === "string" ? shadowOf(agentId, name) : undefined) ??
        globalDefinition(name);
      if (definition === undefined) return undefined;
      return definition.when === undefined ? definition : undefined;
    },
  };

  const makeCtx = (
    handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
    includeTools: boolean,
    agentId = "",
    includeEvents = true,
  ): FakeCtx => ({
    get: (service) => {
      if (Object.prototype.hasOwnProperty.call(serviceValues, service))
        return serviceValues[service];
      return service === "tools"
        ? options.withToolsService === false
          ? undefined
          : tools
        : service === "agents"
          ? options.withAgentsService === false
            ? undefined
            : { list: () => [...agentList] }
          : undefined;
    },
    ...(includeEvents
      ? {
          on: (event: string, callback: (...args: unknown[]) => unknown) => {
            const list = handlers.get(event) ?? [];
            list.push(callback);
            handlers.set(event, list);
            return () => {
              const current = handlers.get(event) ?? [];
              const index = current.indexOf(callback);
              if (index >= 0) current.splice(index, 1);
              if (options.listenerDisposeThrows === true)
                throw new Error("listener disposed");
            };
          },
        }
      : {}),
    ...(options.withEffect === false
      ? {}
      : {
          effect: (callback: () => (() => void) | void) => {
            const dispose = callback();
            if (typeof dispose === "function") effects.push(dispose);
            return dispose;
          },
        }),
    ...(options.withLogger === false
      ? {}
      : {
          logger: () => {
            if (options.loggerThrows === true)
              throw new Error("logger unavailable");
            if (options.loggerPartial === true) return {};
            return {
              info: (message: string) => logs.push({ level: "info", message }),
              warn: (message: string) => logs.push({ level: "warn", message }),
              debug: (message: string) =>
                logs.push({ level: "debug", message }),
            };
          },
        }),
    ...(includeTools
      ? {
          tools: {
            ...tools,
            register: (definition: FakeToolDefinition) =>
              registerScoped(agentId, definition),
            restrict: (filter: { allow?: string[]; deny?: string[] }) =>
              restrictFor(agentId, filter),
          },
        }
      : {}),
  });

  const ctx = makeCtx(globalHandlers, withAgentTools);

  const addAgent: FakeHost["addAgent"] = (agentOptions = {}) => {
    const id = agentOptions.id ?? `agent-${agentList.length + 1}`;
    const agentHandlers = new Map<
      string,
      Array<(...args: unknown[]) => unknown>
    >();
    const agentCtx = makeCtx(agentHandlers, withAgentTools, id, agentEvents);
    const agent: FakeAgent = {
      id,
      session: {
        id,
        ...(agentOptions.header === undefined
          ? {}
          : { header: agentOptions.header }),
      },
      ctx: agentCtx,
      emit: (event, ...args) => {
        let result: unknown;
        for (const handler of agentHandlers.get(event) ?? [])
          result = handler(...args);
        return result;
      },
    };
    agentList.push(agent);
    return agent;
  };

  const holds = new Map<
    string,
    (context: { sessionId: string }) => string | undefined
  >();
  const pinNotes: FakePinNotes = {
    hold: (key, provider) => {
      holds.set(key, provider);
      return () => {
        holds.delete(key);
      };
    },
    keys: () => [...holds.keys()],
    text: (key, sessionId) => holds.get(key)?.({ sessionId }),
  };
  if (!Object.prototype.hasOwnProperty.call(serviceValues, "pinNotes"))
    serviceValues.pinNotes = pinNotes;

  return {
    ctx,
    tools,
    agents: { list: () => [...agentList] },
    restrictCalls,
    registered,
    scoped,
    pinNotes,
    logs,
    addAgent,
    addDefinition: (definition) => {
      options.definitions.push(definition);
      emit("tools/change");
    },
    addSchema: (schema) => {
      options.definitions.push(
        makeDefinition(schema.name, {
          description: schema.description,
          ...(schema.parameters === undefined
            ? {}
            : { parameters: schema.parameters }),
        }),
      );
      emit("tools/change");
    },
    setService: (service, value) => {
      serviceValues[service] = value;
    },
    setHiddenVisible: (names) => {
      hiddenVisible.clear();
      for (const name of names) hiddenVisible.add(name);
    },
    setResidual: (names) => {
      residualNames.clear();
      for (const name of names) residualNames.add(name);
    },
    listenerCount: (event) => {
      if (event !== undefined) return (globalHandlers.get(event) ?? []).length;
      let total = 0;
      for (const list of globalHandlers.values()) total += list.length;
      return total;
    },
    emit,
    dispose: () => {
      for (const dispose of effects.splice(0)) dispose();
    },
    activeDeny: (agentId = "") => {
      const last = [...restrictCalls]
        .reverse()
        .find((call) => !call.disposed && call.agentId === agentId);
      return last?.deny;
    },
    failNextRestrict: (message = "restrict boom") => {
      options.restrictFailure = { message, times: 1 };
    },
  };
}
