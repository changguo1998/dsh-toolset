/**
 * 集成层装配器: 假工具面 + 假服务面 + 假提供面 + 假 `effect` 面, 拼本包 `apply`。
 *
 * 三个假面的形状照 `src/index.ts` 实际消费的结构面抄 (结构化类型, 不 import 宿主包):
 * - 工具面: `ctx.tools.register(def)` 收下 `toDshTool` 产物 (含 `parameters` 与 `output.render`);
 * - 服务面: `ctx.get(name)` 按名给 `clock` / `approval` / `guard` / `subagents`,
 *   缺省一律缺席 (fail-closed / fail-open 路径照真实接线走);
 * - 提供面: `ctx.provide(name, value)` 记下 `taskEngine` 只读查询面。
 *
 * 事件面: 本包**不向宿主发事件**, 事件是内部事件流 (`plan/*`) 的 JSON 快照, 故这里用
 * `snapshotPath` + `events()` 当事件面读 —— 与宿主侧「事件注入后的注入内容」等价可断言。
 *
 * 时钟用 `clock-base` 入口导出的真实 `ManualClock` (跨包只经对端 `src/index.ts`), 超时 /
 * 卸载收尾都能手控推进, 用例不依赖真实等待。本装配器不以 `.test.ts` 结尾, 不计入覆盖率
 * (只统 `src`)。
 */

import { readFileSync } from "node:fs";

import { apply, type Config } from "../src/index.ts";
import { ManualClock } from "@dsh-toolset/clock-base";

/** 注册面收到的工具形态 (`toDshTool` 产物; 只列本装配器用到的字段)。 */
export interface RegisteredTool {
  name: string;
  description: string;
  parameters: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  output?: {
    schema?: unknown;
    render?(args: unknown, value: unknown): { type: string; text: string }[];
  };
}

/** 一次子代理发起 (裁决 run 与执行 run 共用; 只记本装配器断言用的字段)。 */
export interface SubagentStart {
  label: string;
  prompt: string;
  outputSchema?: unknown;
  toolFilter?: unknown;
}

/** 审批链行为: 缺省缺席 (fail-closed), 也可指定放行 / 拒绝 / 抛错。 */
export type ApprovalMode = "allowed-once" | "denied" | "throw" | "absent";

/** 一次 `approval.request` 的入参 (断言 agent / 工具名 / 理由用)。 */
export interface ApprovalRequest {
  agent?: unknown;
  toolName?: string;
  reason?: string;
}

/** 命令复查面 (security-guard 的结构子集)。 */
export type GuardFace = (command: string, source?: string) => string | null;

/** 一次事件流快照里的条目 (`plan/*`)。 */
export interface LoggedEvent {
  type: string;
  seq: number;
  time: number;
  [key: string]: unknown;
}

/** 子代理服务面: 自动应答 (缺省) / 永不结算 (超时与卸载) / 自定义。 */
export type SubagentsOption =
  Record<string, unknown> | "absent" | "hanging" | "auto";

/** 装配选项。 */
export interface AssembleOptions {
  /** 插件配置 (缺省给一条 mechanical 根契约, 命令为 `true`)。 */
  config?: Config;
  /** 审批链行为 (缺省 `absent` = 服务缺席, fail-closed)。 */
  approval?: ApprovalMode;
  /** 命令复查面 (缺省缺席 = fail-open 放行 + 留痕)。 */
  guard?: GuardFace;
  /** 时钟服务 (缺省给一块新的 `ManualClock`; `absent` = 不挂服务, 走进程内回落)。 */
  clock?: ManualClock | "absent" | "broken";
  /** 子代理服务 (缺省自动应答 `entail` / `audit` 裁决)。 */
  subagents?: SubagentsOption;
  /** 工具面缺席 (断言「缺面只告警、不抛错」)。 */
  tools?: "present" | "absent";
  /** 事件流快照落点 (给了才能用 `events()`)。 */
  snapshotPath?: string;
}

/** 装配体。 */
export interface Assembly {
  /** 按名取注册成功的工具。 */
  readonly tools: ReadonlyMap<string, RegisteredTool>;
  /** 注册顺序 (断言工具族名单与顺序)。 */
  readonly order: readonly string[];
  /** 提供面收到的服务 (`taskEngine` 只读查询面)。 */
  readonly provided: ReadonlyMap<string, unknown>;
  /** 装配期写往 stderr 的告警行。 */
  readonly warnings: readonly string[];
  /** 审批链收到的请求 (按次)。 */
  readonly approvalRequests: readonly ApprovalRequest[];
  /** 自动 / 挂起子代理收到的发起 (按次)。 */
  readonly subagentStarts: readonly SubagentStart[];
  /** 本次装配用的手控假时钟 (`clock: "absent"` 时为 undefined)。 */
  readonly clock: ManualClock | undefined;
  /** `clock.scope()` 的入参 (第一项 = 插件 ctx, 第二项 = undefined)。 */
  readonly clockScopes: readonly unknown[];
  /** 执行一个已注册工具 (`exec` 缺省为带 session 的假 agent; 传 `null` 模拟缺上下文)。 */
  call(
    name: string,
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  /** 走注册面的 `output.render` 取投影文本 (第二个形参 = 值)。 */
  render(name: string, value: unknown, args?: unknown): string;
  /** 读事件流快照 (`snapshotPath` 未配置或文件未写时抛错)。 */
  events(): LoggedEvent[];
  /** 跑完所有 `effect` 注销函数 (cordis 卸载语义: 逆序、逐个 await)。 */
  unload(): Promise<void>;
}

/** 缺省根契约: 一条 mechanical 验收, 命令为原子的 `true` (不落盘、不耗时)。 */
const DEFAULT_ROOT: NonNullable<Config["root"]> = {
  title: "R",
  spec: "s",
  acceptance: [
    { id: "r-q", check: "父验收", level: "mechanical", command: "true" },
  ],
};

/** 假工具面: cordis `tools.register` 的最小形态。 */
interface ToolsSurface {
  register(def: unknown): void;
}

/** 假执行上下文: 宿主工具执行时的 `exec` 子集 (`agent` 供 approval / subagent 归属)。 */
export function fakeExec(
  id = "agent-1",
  sessionId = "s1",
): { agent: { id: string; session: { id: string } } } {
  return { agent: { id, session: { id: sessionId } } };
}

/** 剥掉一行 stderr 的换行与插件前缀 (断言用)。 */
function cleanWarning(chunk: string): string {
  return chunk.replace(/^\[task-engine\] warn: /, "").trim();
}

/** 自动应答的假 `subagents`: 裁决 run 按 label 回可解析 JSON, 执行 run 回产物。 */
function autoSubagents(starts: SubagentStart[]): Record<string, unknown> {
  const start = (
    _name: string,
    request: Record<string, unknown>,
  ): Record<string, unknown> => {
    const label = String(request["label"] ?? "");
    const prompt =
      (request["prompt"] as { text?: string }[] | undefined)?.[0]?.text ?? "";
    starts.push({
      label,
      prompt,
      ...(request["outputSchema"] === undefined
        ? {}
        : { outputSchema: request["outputSchema"] }),
      ...(request["toolFilter"] === undefined
        ? {}
        : { toolFilter: request["toolFilter"] }),
    });
    const text = label.startsWith("task:entail:")
      ? '{"ok": true, "feedback": "蕴含成立"}'
      : label.startsWith("task:audit:")
        ? '{"pass": true, "feedback": "验收通过"}'
        : "子代理产出";
    return {
      id: `child-${starts.length}`,
      localAgent: { session: { id: `child-${starts.length}` } },
      result: Promise.resolve({
        stopReason: "completed",
        output: [{ type: "text", text }],
      }),
      dispose: async () => {},
    };
  };
  return {
    getProvider: () => ({
      name: "spawn",
      capabilities: {
        agentOptions: true,
        outputSchema: true,
        toolFilter: true,
      },
    }),
    start,
  };
}

/** 永不结算的假 `subagents`: 造「在途 run」用于超时 / 卸载收尾路径。 */
function hangingSubagents(starts: SubagentStart[]): Record<string, unknown> {
  return {
    getProvider: () => ({
      name: "spawn",
      capabilities: {
        agentOptions: true,
        outputSchema: true,
        toolFilter: true,
      },
    }),
    start: (_name: string, request: Record<string, unknown>) => {
      starts.push({
        label: String(request["label"] ?? ""),
        prompt:
          (request["prompt"] as { text?: string }[] | undefined)?.[0]?.text ??
          "",
      });
      return {
        id: `hanging-${starts.length}`,
        localAgent: { session: { id: `hanging-${starts.length}` } },
        result: new Promise(() => {}),
        dispose: async () => {},
      };
    },
  };
}

/** `clock` 服务面: `scope()` 一律回同一块手控表, 并记下入参。 */
function clockService(
  manual: ManualClock,
  scopes: unknown[],
): Record<string, unknown> {
  return {
    now: () => manual.now(),
    scope(ctx?: unknown): ManualClock {
      scopes.push(ctx);
      return manual;
    },
  };
}

/** 拼装 `apply` 与宿主接线。 */
export async function assemble(
  options: AssembleOptions = {},
): Promise<Assembly> {
  const tools = new Map<string, RegisteredTool>();
  const order: string[] = [];
  const provided = new Map<string, unknown>();
  const warnings: string[] = [];
  const approvalRequests: ApprovalRequest[] = [];
  const subagentStarts: SubagentStart[] = [];
  const clockScopes: unknown[] = [];
  const disposers: Array<() => unknown> = [];
  const manual =
    options.clock === "absent" || options.clock === "broken"
      ? undefined
      : (options.clock ?? new ManualClock(0));

  const services: Record<string, unknown> = {};
  if (manual !== undefined) {
    services["clock"] = clockService(manual, clockScopes);
  } else if (options.clock === "broken") {
    // 形状不符 (`scope` 缺失): `resolveClock` 应回落进程内定时器并告警一次
    services["clock"] = { now: () => 0 };
  }
  if (options.approval !== undefined && options.approval !== "absent") {
    services["approval"] = {
      request: async (req: ApprovalRequest): Promise<unknown> => {
        approvalRequests.push(req);
        if (options.approval === "throw")
          throw new Error("审批面崩了（测试用）");
        return options.approval === "allowed-once" ? "allowed-once" : "denied";
      },
    };
  }
  if (options.guard !== undefined) {
    services["guard"] = { inspectCommand: options.guard };
  }
  const subagents = options.subagents ?? "auto";
  if (subagents === "auto") {
    services["subagents"] = autoSubagents(subagentStarts);
  } else if (subagents === "hanging") {
    services["subagents"] = hangingSubagents(subagentStarts);
  } else if (subagents !== "absent") {
    services["subagents"] = subagents;
  }

  const toolsSurface: ToolsSurface = {
    register(def: unknown): void {
      const tool = def as RegisteredTool;
      tools.set(tool.name, tool);
      order.push(tool.name);
    },
  };
  const ctx = {
    ...(options.tools === "absent" ? {} : { tools: toolsSurface }),
    get: (name: string): unknown => services[name],
    provide: (name: string, value: unknown): void => {
      provided.set(name, value);
    },
    effect: (fn: () => unknown): (() => void) => {
      const dispose = fn();
      if (typeof dispose === "function") {
        disposers.push(dispose as () => unknown);
      }
      return () => {};
    },
  };

  const config: Config = {
    ...options.config,
    root: options.config?.root ?? DEFAULT_ROOT,
    ...(options.snapshotPath === undefined
      ? {}
      : { snapshotPath: options.snapshotPath }),
  };

  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    warnings.push(cleanWarning(String(chunk)));
    return true;
  }) as typeof process.stderr.write;
  try {
    await apply(ctx, config);
  } finally {
    process.stderr.write = original;
  }

  return {
    tools,
    order,
    provided,
    warnings,
    approvalRequests,
    subagentStarts,
    clock: manual,
    clockScopes,
    async call(name, args, exec = fakeExec()) {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`工具未注册：${name}`);
      return await tool.execute(args, exec);
    },
    render(name, value, args = {}) {
      const render = tools.get(name)?.output?.render;
      if (render === undefined)
        throw new Error(`工具缺 output.render：${name}`);
      return render(args, value)[0]?.text ?? "";
    },
    events() {
      if (options.snapshotPath === undefined) {
        throw new Error("未配置 snapshotPath，读不到事件流");
      }
      return JSON.parse(
        readFileSync(options.snapshotPath, "utf8"),
      ) as LoggedEvent[];
    },
    async unload() {
      for (const dispose of disposers.splice(0).reverse()) await dispose();
    },
  };
}
