/**
 * flow-track 插件入口（DSH bundle 接入面）。
 *
 * 角色（决策项 4.0 / 4.4：流程定义方，不再自实现流程推进）——
 * ① 流程定义（`stages.ts`，八阶段节点数组）经**入口工具 `flow_start`** 一次性建树（内部调
 *    task-engine 的编程服务面 `composeFromNodes`，见 `flow-start.ts`）；建树之后节点推进 / 校验 /
 *    验收 / 推送全部由 task-engine 接管，本包不再介入执行期；
 * ② 流程记录（`store.ts`，memory-base 项目层 kind `flow`）由 `flow_record` 写、`flow_status` 读；
 * ③ 合规提示（`observe.ts` 数写类工具调用）与最近记录在回合边界合成一条注入——**树级内容
 *    （阶段模板 / 推进状态）已退役**，当前节点内容由 task-engine 取数、pin-note 保持。
 *
 * 固化强度 = 中档（决策项 4.3 = b）：**只提示不拦截**；节点顺序强制由 task-engine 按流程定义
 * 的 `enforceOrder` 执行。
 *
 * 注入门槛（2026-11-17 起，梳理接口重叠后）：配置 `enabled`、本会话经 flow-arbiter 选中的流程、
 * memory-base 里未完成阶段的流程记录（最新阶段不是「收尾」）三者都满足时才注入；
 * 不再有进程级开关（`switch.ts` 已删，`/flow-track` 只留 `status` 查看），
 * 激活与否由 flow-arbiter 的选中（`/flow-arbiter select <id>`）与配置共同决定。
 *
 * 降级：`pinNotes` 缺席 → 告警且不注入；`memory` 缺席 → 工具返回可读错误、注入里只剩合规提示；
 * `taskEngine` 缺席 → `flow_start` 返回可读错误、`flow_status` 的阶段段退化为没有可识别阶段树；
 * `flowArbiter` 缺席或会话未选中流程 → 注入关闭（`enabled` / `summary` 返回 false / 摘要按关）。
 */

import type { SnapshotLike } from "./status.ts";
import { FlowStore, type FlowRecord, type MemoryFaceLike } from "./store.ts";
import { WriteObserver, type SessionEventLike } from "./observe.ts";
import { decideText } from "./inject.ts";
import { STAGE_NAMES, hasActiveFlow } from "./policy.ts";
import { FLOW_ID, FLOW_NAME } from "./stages.ts";
import { registerFlowCommand } from "./command.ts";
import {
  flowStartTool,
  type ComposeFace,
  type ComposeResultLike,
  type FlowNodeInput,
} from "./flow-start.ts";
import { flowTools } from "./tools.ts";
import { callerSessionId } from "./tools.ts";
import { wrapToolDefinition } from "@dsh-toolset/tool-surface";

export const name = "flow-track";

/**
 * 注入面：`tools` 是硬依赖（装配期要注册工具面，缺面时注册不了，cordis 需要在场才激活）；
 * 动态保持经 pin-note 的 `pinNotes.hold` 登记，`memory` / `taskEngine` / `pinNotes` 都是可选服务，
 * 经反射面按调用现读。
 */
export const inject = ["tools"];

/** 对外只读服务面：`flowTrack.enabled(sessionId?)` 与 `flowTrack.summary(sessionId?)`（TUI 标题栏 /
 *  状态列据此显示）；enabled / summary.enabled 按会话的流程选中派生（配置 + flow-arbiter）。 */
export const provide = ["flowTrack"];

/** 服务面单条摘要：某个 slug 的最新真实阶段（跳过 `-`）。 */
export interface FlowSummaryRecord {
  slug: string;
  stage: string;
  status: string;
  /** 最新阶段不是「收尾」（即流程未完成）。 */
  active: boolean;
}

/** 服务面摘要：开关态 + 按 slug 汇总的最新记录（最近创建的在前）。 */
export interface FlowSummary {
  enabled: boolean;
  records: FlowSummaryRecord[];
}

/** 由记录缓存生成服务面摘要（纯函数；`-` 备注不参与阶段推导）。 */
export function flowSummaryOf(
  records: readonly FlowRecord[],
  enabled: boolean,
): FlowSummary {
  const bySlug = new Map<string, FlowRecord>();
  for (const record of records) {
    if (record.stage === "-") continue;
    bySlug.set(record.slug, record);
  }
  const done = STAGE_NAMES[STAGE_NAMES.length - 1] ?? "收尾";
  const out = [...bySlug.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((record) => ({
      slug: record.slug,
      stage: record.stage,
      status: record.status,
      active: record.stage !== done,
    }));
  return { enabled, records: out };
}

/** 插件配置（类型声明，宿主不校验；缺省见 resolveConfig）。 */
export interface Config {
  /** 是否开启注入（缺省 `true`；显式 `false` 时工具仍可用）。 */
  enabled?: boolean;
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
}

/** 归一化配置（非法值回退缺省，不抛错）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  return { enabled: config?.enabled !== false };
}

/** pin-note 动态保持登记面（结构化类型；未挂载时降级）。 */
interface PinNotesLike {
  hold?(
    key: string,
    provider: (context: { sessionId: string }) => string | undefined,
  ): () => void;
}

/** 只读快照面（task-engine `provide("taskEngine")`；`composeFromNodes` = 编程建树入口）。 */
interface TaskEngineFace {
  query?(): SnapshotLike;
  frameStack?(): readonly string[];
  composeFromNodes?(
    parentId: string | undefined,
    nodes: FlowNodeInput[],
  ): Promise<ComposeResultLike>;
}

/** 插件上下文的结构化面。 */
interface PluginContext {
  get?(name: string): unknown;
  tools?: { register(def: unknown): unknown };
  provide?(name: string, value: unknown): unknown;
  on?(event: string, handler: (...args: unknown[]) => unknown): () => void;
  logger?: { warn?: (message: string) => void };
}

/** 反射面（`ctx.reflect.get`：不要求 inject 就能读服务）。 */
interface ReflectLike {
  get?(name: string): unknown;
}

/**
 * 读一个服务（本包未 inject 的服务经 `ctx.reflect.get` 读；取不到返回 undefined）。
 *
 * 直接读 `ctx.memory` 这类未 inject 的服务属性在 cordis 里会抛错，故先走反射面，
 * 再退回属性读（两者都包在 try 里）。
 */
function readService<T>(
  ctx: PluginContext,
  serviceName: string,
): T | undefined {
  let reflect: ReflectLike | undefined;
  try {
    reflect = (ctx as { reflect?: ReflectLike }).reflect;
  } catch {
    reflect = undefined;
  }
  if (typeof reflect?.get === "function") {
    try {
      const value = reflect.get(serviceName);
      if (value !== undefined) return value as T;
    } catch {
      /* 反射面读失败：落到属性读 */
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[serviceName] as
      T | undefined;
  } catch {
    return undefined;
  }
}

/** 组装只读快照（taskEngine 缺席或抛错 → undefined）。 */
function snapshotOf(
  engine: TaskEngineFace | undefined,
): SnapshotLike | undefined {
  if (engine === undefined || typeof engine.query !== "function")
    return undefined;
  try {
    return engine.query();
  } catch {
    return undefined;
  }
}

/** 会话事件里取会话 id（`session.id`）。 */
function sessionIdOf(session: unknown): string | undefined {
  const id = (session as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** 建树帧 id 前缀（进程内递增 + 时间戳基数：跨轮 / 多次建树都不撞 id）。 */
let flowSeq = 0;
function nextFlowPrefix(): string {
  flowSeq += 1;
  return `flow-${Date.now().toString(36)}-${flowSeq}`;
}

/**
 * 挂载：注册两个工具、订阅 `session/event` 记账、注册 rule-engine 消费者。
 * 返回 dispose（注销消费者与事件订阅）。
 */
export function apply(ctx: unknown, config?: Config): () => void {
  const c = (ctx ?? {}) as PluginContext;
  const logger = readService<{ warn?(message: string): void }>(c, "logger");
  const warn = (message: string): void => {
    if (typeof logger?.warn === "function") {
      logger.warn(`[flow-track] ${message}`);
      return;
    }
    process.stderr.write(`[flow-track] warn: ${message}\n`);
  };
  const resolved = resolveConfig(config);
  // memory 懒解析：装配顺序不保证 memory-base 先就绪，每次调用重读服务（FlowStore 内部实现）
  const store = new FlowStore(() => readService<MemoryFaceLike>(c, "memory"));
  if (!store.available) {
    warn(
      `流程记录暂不可写入（memory 服务尚未就绪）：${store.unavailableReason ?? "原因未知"}`,
    );
  }
  const taskEngine = readService<TaskEngineFace>(c, "taskEngine");
  if (taskEngine === undefined) {
    warn("ctx.taskEngine 不可用，flow_start 无法建树、推进状态段会退化");
  }
  // 编程建树入口（决策项 5）：**每次调用现读**（装配顺序不保证 task-engine 先 provide）；
  // task-engine 版本不支持该入口时 flow_start 返回可读错误，其余工具照常
  const composeOf = (): ComposeFace | undefined => {
    const face = readService<TaskEngineFace>(c, "taskEngine");
    const entry = face?.composeFromNodes;
    if (face === undefined || typeof entry !== "function") return undefined;
    return (parentId, nodes) => entry.call(face, parentId, nodes);
  };
  if (composeOf() === undefined) {
    warn("ctx.taskEngine 未暴露 composeFromNodes，flow_start 暂不可用");
  }

  const observer = new WriteObserver();
  const disposers: Array<() => void> = [];

  /** 流程选中读取（决策项 4a）：会话经 flow-arbiter 选中才进"流程态"；缺席 / 未选中 / 抛错 → undefined。 */
  const selectedFlow = (
    sessionId: string | undefined,
  ): { id: string; name: string } | undefined => {
    if (sessionId === undefined) return undefined;
    const arbiter = readService<{
      current?(sessionId: string): { id?: string; name?: string } | null;
    }>(c, "flowArbiter");
    if (arbiter === undefined || typeof arbiter.current !== "function")
      return undefined;
    try {
      const cur = arbiter.current(sessionId);
      if (cur === null || cur === undefined) return undefined;
      if (typeof cur.id !== "string" || cur.id.length === 0) return undefined;
      return {
        id: cur.id,
        name: typeof cur.name === "string" ? cur.name : cur.id,
      };
    } catch {
      return undefined;
    }
  };

  /** 注入是否对某会话生效：配置 `enabled` 且本会话已选中流程（2026-11-17 起，替代进程级开关）。 */
  const enabledFor = (sessionId: string | undefined): boolean =>
    resolved.enabled && selectedFlow(sessionId) !== undefined;

  /** 记录缓存：`decide` 是同步的，读库（异步）只能提前喂进来。 */
  const cache: { records: FlowRecord[] } = { records: [] };
  const refresh = async (): Promise<void> => {
    try {
      cache.records = await store.list({ limit: 20 });
    } catch {
      cache.records = [];
    }
  };
  void refresh();

  // 只读服务面：TUI 标题栏 / 状态列每 tick 懒读（装载顺序与 HMR 都由懒读兜住）
  if (typeof c.provide === "function") {
    try {
      c.provide("flowTrack", {
        enabled: (sessionId?: string) => enabledFor(sessionId),
        summary: (sessionId?: string): FlowSummary =>
          flowSummaryOf(cache.records, enabledFor(sessionId)),
      });
    } catch (error) {
      warn(`服务面 flowTrack 暴露失败（忽略）：${String(error)}`);
    }
  } else {
    warn("ctx.provide 不可用，TUI 读不到 flow-track 开关与流程摘要");
  }

  const tools = readService<{ register(def: unknown): unknown }>(c, "tools");
  if (tools !== undefined && typeof tools.register === "function") {
    const deps = {
      store,
      observer,
      snapshot: () => snapshotOf(taskEngine),
      slugFor: (sessionId: string) => sessionId,
      enabledFor,
      active: () => hasActiveFlow(cache.records),
      onRecorded: () => void refresh(),
    };
    // 工具面顺序：流程入口在前，记录类工具在后
    const toolDefs = [
      flowStartTool({ compose: composeOf, prefix: nextFlowPrefix }),
      ...flowTools(deps),
    ];
    for (const tool of toolDefs) {
      try {
        // 注册前套包装层: 模型侧只见短说明与宽松占位, 全文与完整 schema 留给 consult_tools 投递,
        // 参数按完整 schema 在派发前严格校验（tool-surface 包）
        tools.register(wrapToolDefinition(tool));
      } catch (error) {
        warn(`工具 ${tool.name} 注册失败：${String(error)}`);
      }
    }
  } else {
    warn("ctx.tools 不可用，flow_record / flow_status 不会出现");
  }

  // 向流程仲裁登记自身（决策项 8 的协作面）：仲裁缺席时跳过——仲裁侧内置两条默认登记，
  // 装配顺序不影响拦截（工具恒注册，拦截在执行前判定）
  const arbiter = readService<{
    register?(flow: { id: string; name: string; entry: string }): unknown;
  }>(c, "flowArbiter");
  if (arbiter !== undefined && typeof arbiter.register === "function") {
    try {
      arbiter.register({ id: FLOW_ID, name: FLOW_NAME, entry: "flow_start" });
    } catch (error) {
      warn(`向 flow-arbiter 登记流程失败（忽略）：${String(error)}`);
    }
  }

  // `/flow-track` 命令面（commands 缺席时降级, 不影响工具面与注入）
  const commands = readService<{
    register(def: unknown): unknown;
  }>(c, "commands");
  const offCommand = registerFlowCommand(commands, {
    configEnabled: resolved.enabled,
    selected: selectedFlow,
    hasActive: () => hasActiveFlow(cache.records),
    sessionOf: (invocation) => callerSessionId(invocation),
  });
  if (offCommand === undefined) {
    warn("ctx.commands 不可用，/flow-track 命令不会出现");
  } else {
    disposers.push(offCommand);
  }

  if (typeof c.on === "function") {
    const off = c.on("session/event", (...args: unknown[]) => {
      const sessionId = sessionIdOf(args[0]);
      const event = args[1] as SessionEventLike | undefined;
      if (sessionId === undefined || event === undefined) return;
      observer.observe(sessionId, event);
      // 写类调用后刷一次记录缓存（下一次 decide 就能看到最新状态）
      void refresh();
    });
    if (typeof off === "function") disposers.push(off);
  } else {
    warn("ctx.on 不可用，合规观测不会生效（请检查宿主版本）");
  }

  // 注入：动态保持 —— 合规提示与最近记录经 pinNotes.hold("flow") 按 key 比对；
  // 树级内容（阶段模板 / 推进状态）不在这里注入（决策项 4.4：由 task-engine 取当前节点、pin-note 保持）
  const pinNotes = readService<PinNotesLike>(c, "pinNotes");
  if (pinNotes === undefined || typeof pinNotes.hold !== "function") {
    warn(
      "ctx.pinNotes 不可用，合规提示与最近记录不会注入（请检查 pin-note 是否挂载）",
    );
  } else {
    try {
      const off = pinNotes.hold("flow", (context) => {
        if (!resolved.enabled) return undefined;
        if (selectedFlow(context.sessionId) === undefined) return undefined;
        // 门槛之三：memory-base 里要有未完成阶段的流程记录（与 task-engine 阶段树无关）
        if (!hasActiveFlow(cache.records)) return undefined;
        const lastWriteTool = observer.lastWriteTool(context.sessionId);
        return decideText({
          records: cache.records,
          writeSeen: observer.writeSeen(context.sessionId),
          ...(lastWriteTool === undefined ? {} : { lastWriteTool }),
        });
      });
      if (typeof off === "function") disposers.push(off);
    } catch (error) {
      warn(`登记 pinNotes.hold 失败：${String(error)}`);
    }
  }

  return () => {
    for (const dispose of disposers) dispose();
    observer.clear();
  };
}
