/**
 * rule-engine 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0：导出 `name` / `inject` / `provide` / `Config` / `apply`，
 * 无 default export；`Config` 以类型声明给出（无运行时 schema，宿主不校验、配置原样透传，
 * 缺省/非法值由本包归一化层收敛）。零 DSH 运行时依赖：结构面访问 ctx。
 *
 * `inject: ["agents", "sessions"]` 是**硬依赖**（cordis 语义：任一不可用则插件整体等待、不加载），
 * 因为本插件的核心动作必须两者齐备；`tools` 只承载工具族，缺失时降级告警而非整体不加载
 * （profile fff 三者都在，仍按可降级写以防换组合）。
 *
 * 数据流：`ctx.on("session/event")` → 引擎（聚合/匹配/节流） → 注入器（推迟宏任务 →
 * `agents.get(sessionId)` → 按 `delivery` 走 `followup` / `steer` / `inject` →
 * `sessions.flush(...)`）。时序红线见 inject.ts 文件头。
 *
 * 告警出口：缺省写 stderr；`provide("ruleEngine")` 上出现 `onNotice` 订阅者（TUI）后改发
 * 总线（活动区展示，项目级 #61 方案 B）；无订阅者（headless）回退 stderr。
 *
 * 规则来源两层：apply 的 `config.rules`（只读基线）+ 模型面工具族运行时增删改
 * （落 `~/.dsh/rule-engine/rules.json`，可用 `RULE_ENGINE_STATE_DIR` 覆盖目录）。
 */

import { RuleEngine } from "./engine.ts";
import { createAgentInjector } from "./inject.ts";
import { defaultStateDir } from "./persist.ts";
import { toToolDefs } from "./tools.ts";
import type {
  Config,
  ConsumerRegistration,
  EvaluateInput,
  EvaluateResult,
  RuleSummary,
  NoticeEvent,
  SessionEventLike,
  SessionLike,
} from "./types.ts";

/** 宿主子代理会话判据（`session.header.origin === "subagent"` 或 `delegationDepth > 0`）：
 *  本引擎面向用户会话（消费者 / 注入面），子代理不参与（见 BACKLOG「子代理会话参与
 *  消费者评估 → 已关闭句柄 flush 告警（SessionHandleClosedError）」）。 */
export function isSubagentSession(session: unknown): boolean {
  const header = (
    session as {
      header?: { origin?: unknown; delegationDepth?: unknown };
    } | null
  )?.header;
  if (header === undefined || header === null) return false;
  if (header.origin === "subagent") return true;
  const depth = header.delegationDepth;
  return typeof depth === "number" && depth > 0;
}

export const name = "rule-engine";

/** 硬依赖：事件面（sessions）与注入面（agents）。 */
export const inject = ["agents", "sessions"];

/** 提供的服务名（宿主命令 / 其他插件经 ctx.get('ruleEngine') 访问查询与注册面）。 */
export const provide = ["ruleEngine"];

export type { Config } from "./types.ts";
export { RuleEngine } from "./engine.ts";
export {
  buildInjectionMessage,
  createAgentInjector,
  defaultWarn,
  SOURCE_KIND,
} from "./inject.ts";
export type { AgentLike, InjectionHost, InjectorOptions } from "./inject.ts";
export {
  boundSummary,
  compileMatcher,
  isPredicateName,
  messageText,
  predicateNames,
  SUMMARY_MAX_CHARS,
  toolCallText,
} from "./match.ts";
export {
  defaultStateDir,
  emptyLayer,
  loadLayer,
  saveLayer,
  STATE_VERSION,
  statePathFor,
} from "./persist.ts";
export {
  effectiveRules,
  isRuleDelivery,
  isRuleSource,
  normalizeRule,
  RULE_DELIVERIES,
  RULE_SOURCES,
} from "./rules.ts";
export { toToolDefs } from "./tools.ts";
export type { ToolDef } from "./tools.ts";
export type * from "./types.ts";

/** 事件总线最小形态（cordis ctx 结构性访问）。 */
interface EventBus {
  on(
    event: "session/event",
    listener: (session: SessionLike, event: SessionEventLike) => void,
  ): unknown;
  /** 会话建立（含恢复）事件：载荷为 session 句柄。 */
  on(event: "session/created", listener: (session: unknown) => void): unknown;
}

/** 工具注册面最小形态。 */
interface ToolsRegistrar {
  register(def: unknown): void;
}

/** 会话投影注册表最小形态（`ctx.get('sessionProjections')`；只读某会话的投影状态）。 */
interface ProjectionRegistryLike {
  stateOf(session: unknown, key: string): unknown;
}

/** ctx 结构面（只声明本插件用到的成员）。 */
interface PluginContext {
  on?: EventBus["on"];
  /** 可选服务读取（cordis 严格模式禁止未注入服务的直接属性访问，须经 ctx.get）。 */
  get?: (name: string) => unknown;
  agents?: {
    get(
      id: string,
    ):
      | { session?: unknown; followup?(message: unknown): void }
      | undefined
      | null;
  };
  sessions?: {
    flush(session: unknown): unknown;
    /** 会话句柄读取（`dedupeInRecord` 判据用：可见投影 + inbox 待消费；缺省 → 去重失效、照旧注入）。 */
    get?(id: string): unknown;
  };
  provide?: (name: string, value: unknown) => unknown;
}

/** 消费者面（供 TUI 等插件注册 / 查询；规则清单与状态为只读）。 */
export interface RuleEngineService {
  /** 生效规则清单（只读子集）。 */
  list(): RuleSummary[];
  /** 引擎状态（规则条数、状态目录、注入上限）。 */
  status(): ReturnType<RuleEngine["status"]>;
  /** 只读判定：返回命中规则（含可注入内容），不注入、不改状态。 */
  evaluate(input: EvaluateInput): EvaluateResult;
  /** 消费者注册：按注册的 `sources` 在对应节点唤醒 decide，反馈由本引擎统一注入；返回注销函数。 */
  registerConsumer(input: ConsumerRegistration): () => void;
  /** 订阅插件告警（完整展示行 + tone；项目级 #61 方案 B）；返回注销函数。 */
  onNotice(listener: (event: NoticeEvent) => void): () => void;
}

/** 默认注入上限。 */
export const DEFAULT_MAX_INJECTIONS_PER_TURN = 3;

/**
 * DSH 宿主按 bundle 契约调用：惰性、防御，加载失败只告警不抛。
 * 自证日志写 stderr（cordis 的 inject 缺失是「等待」而非报错，插件静默不加载时靠它排查）。
 */
export async function apply(ctx: unknown, config?: Config): Promise<void> {
  // 告警总线：有订阅者（TUI 经 provide("ruleEngine").onNotice）时发总线、不写 stderr；
  // 无订阅者（headless）回退 stderr。展示通道失败不回流、不向宿主抛（项目级 #61 方案 B）。
  const noticeListeners = new Set<(event: NoticeEvent) => void>();
  // 装载期告警缓冲（BACKLOG TUI「装载期告警不进活动区」）：插件装载早于 TUI 的 stderr 桥 /
  // 总线的订阅，此时直写 stderr 的告警在活动区看不到；先挂起，首个订阅者注册时重放。
  // headless 兜底不变：无订阅者时仍写 stderr。
  const pendingNotices: string[] = [];
  const MAX_PENDING_NOTICES = 64;
  const warn = (message: string): void => {
    const line = `[rule-engine] warn: ${message}`;
    if (noticeListeners.size === 0) {
      pendingNotices.push(line);
      if (pendingNotices.length > MAX_PENDING_NOTICES) pendingNotices.shift();
      process.stderr.write(`${line}\n`);
      return;
    }
    for (const listener of [...noticeListeners]) {
      try {
        listener({ text: line, tone: "warn" });
      } catch {
        // 订阅者自身出错：忽略（展示通道，不影响告警链路与宿主 run 收尾）
      }
    }
  };
  const c = (ctx ?? {}) as PluginContext;
  try {
    const stateDir = config?.stateDir ?? defaultStateDir();
    const injector = createAgentInjector(
      { agents: c.agents, sessions: c.sessions },
      { warn },
    );
    // 会话投影注册表（可选面）：`dedupeInRecord` 判据要读 inbox 待消费注入，见 sessionMessagesOf
    const projections = readOptional<ProjectionRegistryLike>(
      c,
      "sessionProjections",
    );
    const engine = new RuleEngine({
      baseline: config?.rules ?? [],
      stateDir,
      injector,
      maxInjectionsPerTurn:
        config?.maxInjectionsPerTurn ?? DEFAULT_MAX_INJECTIONS_PER_TURN,
      messagesOf: (sessionId) =>
        sessionMessagesOf(c.sessions, sessionId, projections),
      warn,
    });

    // 事件订阅：disposer 随插件 fiber 卸载自动回收（cordis 语义），此处不额外持有
    if (typeof c.on !== "function") {
      warn("ctx.on 不可用，规则不会随事件触发（工具族仍可管理规则）");
    } else {
      c.on("session/event", (session, event) => {
        // 子代理会话不参与本引擎（消费者 / 注入面面向用户会话）：跳过其全部事件，
        // 避免子代理结束后的延迟 flush 打到已关闭句柄（BACKLOG「子代理会话参与消费者评估」）。
        if (isSubagentSession(session)) return;
        engine.handle(session, event);
      });
      // `session/created`（含恢复）→ `session-start` 节点。宿主注释：throwing listener 会
      // 回滚会话 attach，故监听器永不抛（引擎侧 sessionCreated 已兜底）。
      try {
        c.on("session/created", (session: unknown) => {
          // 与 `session/event` 同口径：子代理会话不参与本引擎
          if (isSubagentSession(session)) return;
          const id = (session as { id?: unknown } | null)?.id;
          engine.sessionCreated(typeof id === "string" ? id : "", session);
        });
      } catch (err) {
        warn(`session/created 订阅失败：${String(err)}`);
      }
    }

    // 工具族：缺 tools 时降级（核心事件订阅已生效）。
    // 注意：tools 不在 inject 声明中——cordis 严格模式对未注入服务的直接属性访问会抛
    // `cannot get property "tools" without inject`（2026-09-27 真机实测），故经 ctx.get 读取。
    const tools = readOptional<ToolsRegistrar>(c, "tools");
    if (tools === undefined || typeof tools.register !== "function") {
      warn("ctx.tools 不可用，规则工具族未注册（规则仍按事件触发）");
    } else {
      try {
        for (const def of toToolDefs(engine)) tools.register(def);
      } catch (err) {
        warn(`工具族注册失败：${String(err)}`);
      }
    }

    // 只读查询面
    if (typeof c.provide === "function") {
      try {
        c.provide("ruleEngine", {
          list: () => engine.summaries(),
          status: () => engine.status(),
          evaluate: (input: EvaluateInput): EvaluateResult =>
            engine.evaluate(input),
          registerConsumer: (input: ConsumerRegistration): (() => void) =>
            engine.registerConsumer(input),
          onNotice: (listener: (event: NoticeEvent) => void): (() => void) => {
            const first = noticeListeners.size === 0;
            noticeListeners.add(listener);
            // 首个订阅者：重放装载期挂起的告警（重放仅发生一次）
            if (first && pendingNotices.length > 0) {
              for (const text of pendingNotices.splice(0)) {
                try {
                  listener({ text, tone: "warn" });
                } catch {
                  // 订阅者自身出错：忽略（展示通道，不影响告警链路）
                }
              }
            }
            return () => {
              noticeListeners.delete(listener);
            };
          },
        } satisfies RuleEngineService);
      } catch (err) {
        warn(`提供 ruleEngine 服务失败：${String(err)}`);
      }
    }

    const status = engine.status();
    process.stderr.write(
      `[rule-engine] 已加载：规则 ${status.rules} 条（运行时 ${status.runtimeRules} 条），stateDir=${status.stateDir}\n`,
    );
  } catch (err) {
    warn(`初始化失败：${String(err)}`);
  }
}

/**
 * 会话记录读面（`dedupeInRecord` 判据）：**可见投影**（`deriveMessages()`）加**仍在 inbox
 * 待消费**的注入消息（`sessionProjections` 的 `inbox` 投影：`next-step` / `next-turn`）。
 *
 * 为什么必须带上 inbox：`steer` / `inject` 注入先落 `next-step` 队列，直到**下一个步边界**
 * 才被 claim 进会话；而 `step-end` 派发发生在同一边界、且早于 claim——只读投影会把刚写出的
 * 注入判成「不存在」，使 `session-start` 之后的第一个 `step-end` 重复注入（2026-10-05 真机
 * 会话实证：seq 6 注入 → seq 17 step/end 判定 → seq 18 才 claim → seq 19 重复注入符号指南
 * 与 ponytail）。inbox 投影随会话日志持久重建（重启后仍准）；被 claim 后自然从 inbox 转入
 * 可见投影，计数不变量不变。
 *
 * 读不到（宿主面缺失 / 投影未注册 / 抛错）→ 只返回可见投影（照旧注入，fail-open：
 * 宁可重复，不可永久丢注入）。
 */
function sessionMessagesOf(
  sessions: PluginContext["sessions"],
  sessionId: string,
  projections?: ProjectionRegistryLike,
): readonly unknown[] {
  const session = sessions?.get?.(sessionId);
  return [
    ...derivedMessagesOf(session),
    ...pendingInboxMessages(projections, session),
  ];
}

/** 可见投影消息（`deriveMessages()`；读不到 / 未实现 → 空数组）。 */
function derivedMessagesOf(session: unknown): readonly unknown[] {
  const messages = (
    session as { deriveMessages?: () => unknown } | null | undefined
  )?.deriveMessages?.();
  return Array.isArray(messages) ? messages : [];
}

/** inbox 待消费消息（`next-step` + `next-turn`；读不到 / 非法 → 空数组）。 */
function pendingInboxMessages(
  projections: ProjectionRegistryLike | undefined,
  session: unknown,
): readonly unknown[] {
  if (projections === undefined || session === undefined || session === null) {
    return [];
  }
  try {
    const state = projections.stateOf(session, "inbox") as {
      "next-step"?: unknown;
      "next-turn"?: unknown;
    } | null;
    const out: unknown[] = [];
    for (const list of [state?.["next-step"], state?.["next-turn"]]) {
      if (Array.isArray(list)) out.push(...list);
    }
    return out;
  } catch {
    return [];
  }
}

/** 可选服务的严格安全读取（未注入服务的直接属性访问在 cordis 严格模式下抛错）。 */
function readOptional<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    return ctx.get?.(name) as T | undefined;
  } catch {
    return undefined;
  }
}
