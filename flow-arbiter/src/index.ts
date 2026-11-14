/**
 * flow-arbiter 插件入口（DSH bundle 接入面）。
 *
 * 角色（决策项 7 / 8）：**流程选择仲裁**——同一会话同一时刻只放行一个流程的入口工具。
 * 三件组成：
 * ① 会话级选中状态（`state.ts`，进程内内存，不落盘）；
 * ② 模型侧 `flow_select` 工具 + `/flow-arbiter` 命令面（选中 / 取消 / 查看）；
 * ③ `tools/pre-execute` 监听器：只拦**流程入口工具**（`flow_start` / `plan_start` …），
 *    未选中或选中别的流程 → `deny`；其它工具一律放行。
 *
 * 缓存友好（决策项 9① / ③）：工具恒注册、工具面不随选中状态增删；选中状态是内存态、不进 prompt，
 * 切换流程只改放行规则；真正改变上下文的是**建树**（流程入口执行成功之后）。
 *
 * 降级：`tools` 是硬依赖（装配期注册工具面）；`on` 缺席 → 只告警不拦截（选择工具仍可用）。
 */

import { wrapToolDefinition } from "@dsh-toolset/tool-surface";

import { registerArbiterCommand } from "./command.ts";
import {
  FlowArbiterState,
  DEFAULT_FLOWS,
  type FlowRegistration,
} from "./state.ts";
import { callerSessionId, flowSelectTool, type ToolDef } from "./tool.ts";

export const name = "flow-arbiter";

/** 注入面：装配期要注册工具面，`tools` 是硬依赖。 */
export const inject = ["tools"];

/** 对外服务面：流程插件可登记自身，调用方可查询当前选择。 */
export const provide = ["flowArbiter"];

/** 插件配置（类型声明，宿主不校验；缺省见 apply 内归一）。 */
export interface Config {
  /** 流程登记表（缺省 = 内置两条：标准流程八阶段 / plan 模式三段）。 */
  flows?: { id: string; name: string; entry: string }[];
}

/** 宿主工具执行对象（`tools/pre-execute` 载荷的结构子集）。 */
interface ToolExecutionLike {
  name?: unknown;
  agent?: { session?: { id?: unknown } };
  session?: { id?: unknown };
}

/** 结构面：插件上下文。 */
interface PluginContext {
  get?(name: string): unknown;
  tools?: { register(def: unknown): unknown };
  commands?: { register(def: unknown): unknown };
  on?(event: string, handler: (...args: unknown[]) => unknown): () => void;
  provide?(name: string, value: unknown): unknown;
  logger?: { warn?(message: string): void };
}

/** `tools/pre-execute` 的 deny 回执（宿主 waterfall 口径）。 */
interface DenyDecision {
  kind: "deny";
  reason: string;
  info: { name: string; code: string };
}

/** 读一个服务（`ctx.get` 优先，退回属性读）。 */
function readService<T>(ctx: PluginContext, service: string): T | undefined {
  try {
    const value = ctx.get?.(service);
    if (value !== undefined) return value as T;
  } catch {
    /* ctx.get 抛错：落到属性读 */
  }
  try {
    return (ctx as Record<string, unknown>)[service] as T | undefined;
  } catch {
    return undefined;
  }
}

/** 归一配置里的流程登记（非法项丢弃并告警）。 */
function flowsOf(
  config: Config | undefined,
  warn: (m: string) => void,
): FlowRegistration[] {
  const fromConfig = config?.flows;
  if (fromConfig === undefined) return [...DEFAULT_FLOWS];
  const out: FlowRegistration[] = [];
  for (const flow of fromConfig) {
    if (
      typeof flow?.id !== "string" ||
      flow.id.trim() === "" ||
      typeof flow.name !== "string" ||
      flow.name.trim() === "" ||
      typeof flow.entry !== "string" ||
      flow.entry.trim() === ""
    ) {
      warn("配置里的流程登记缺 id / name / entry，已忽略");
      continue;
    }
    out.push({ id: flow.id, name: flow.name, entry: flow.entry });
  }
  return out.length > 0 ? out : [...DEFAULT_FLOWS];
}

export function apply(ctx: unknown, config?: Config): () => void {
  const c = (ctx ?? {}) as PluginContext;
  const logger = readService<{ warn?(message: string): void }>(c, "logger");
  const warn = (message: string): void => {
    if (typeof logger?.warn === "function") {
      logger.warn(`[flow-arbiter] ${message}`);
      return;
    }
    process.stderr.write(`[flow-arbiter] warn: ${message}\n`);
  };
  const state = new FlowArbiterState(flowsOf(config, warn));
  const disposers: Array<() => void> = [];

  // ① 选择工具（恒注册，选中状态只改内存里的放行规则）
  const tools = readService<{ register(def: unknown): unknown }>(c, "tools");
  if (tools === undefined || typeof tools.register !== "function") {
    warn("ctx.tools 不可用，flow_select 不会出现");
  } else {
    const tool: ToolDef = flowSelectTool(state);
    try {
      tools.register(wrapToolDefinition(tool));
    } catch (error) {
      warn(`工具 ${tool.name} 注册失败：${String(error)}`);
    }
  }

  // ② 命令面（用户面同款入口；commands 缺席时降级）
  const offCommand = registerArbiterCommand(
    readService<{ register(def: unknown): unknown }>(c, "commands"),
    {
      state,
      sessionOf: (invocation) =>
        callerSessionId(
          invocation as { agent?: unknown; session?: unknown } | undefined,
        ),
    },
  );
  if (offCommand === undefined) {
    warn("ctx.commands 不可用，/flow-arbiter 命令不会出现");
  } else {
    disposers.push(offCommand);
  }

  // ③ 入口拦截：只作用在流程入口工具那一刻（工具面不增删，缓存友好）
  if (typeof c.on === "function") {
    const off = c.on("tools/pre-execute", (...args: unknown[]) => {
      const exec = args[0] as ToolExecutionLike | undefined;
      const next = args[1] as (() => unknown) | undefined;
      const passthrough = (): unknown =>
        typeof next === "function" ? next() : { kind: "allow" };
      const toolName = exec?.name;
      if (typeof toolName !== "string") return passthrough();
      const decision = state.decide(callerSessionId(exec), toolName);
      if (decision.kind === "skip") return passthrough();
      if (decision.kind === "allow") return passthrough();
      const denied: DenyDecision = {
        kind: "deny",
        reason: decision.reason,
        info: { name: "flow_not_selected", code: "flow_not_selected" },
      };
      return denied;
    });
    if (typeof off === "function") disposers.push(off as () => void);
  } else {
    warn("ctx.on 不可用，流程入口拦截不会生效（请检查宿主版本）");
  }

  // 服务面：流程插件登记自身 + 调用方查询当前选择
  const provideSvc = (
    c as { provide?: (name: string, value: unknown) => unknown }
  ).provide;
  if (typeof provideSvc === "function") {
    try {
      provideSvc("flowArbiter", {
        register: (flow: FlowRegistration) => state.register(flow),
        select: (sessionId: string, flowId: string) =>
          state.select(sessionId, flowId),
        clear: (sessionId: string) => state.clear(sessionId),
        current: (sessionId: string) => state.current(sessionId) ?? null,
        flows: () => state.list(),
      });
    } catch (error) {
      warn(`服务面 flowArbiter 暴露失败（忽略）：${String(error)}`);
    }
  } else {
    warn("ctx.provide 不可用，流程插件登记不到仲裁");
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
