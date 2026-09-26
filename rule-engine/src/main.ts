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
 * `agents.get(sessionId).followup(...)` → `sessions.flush(...)`）。时序红线见 inject.ts 文件头。
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
  RuleSummary,
  SessionEventLike,
  SessionLike,
} from "./types.ts";

export const name = "rule-engine";

/** 硬依赖：事件面（sessions）与注入面（agents）。 */
export const inject = ["agents", "sessions"];

/** 提供的服务名（宿主命令经 ctx.get('ruleEngine') 访问只读查询面）。 */
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
  isRuleSource,
  normalizeRule,
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
}

/** 工具注册面最小形态。 */
interface ToolsRegistrar {
  register(def: unknown): void;
}

/** ctx 结构面（只声明本插件用到的成员）。 */
interface PluginContext {
  on?: EventBus["on"];
  tools?: ToolsRegistrar;
  agents?: {
    get(
      id: string,
    ):
      | { session?: unknown; followup?(message: unknown): void }
      | undefined
      | null;
  };
  sessions?: { flush(session: unknown): unknown };
  provide?: (name: string, value: unknown) => unknown;
}

/** 只读查询面（供将来 TUI `/rule` 面板等宿主命令消费）。 */
export interface RuleEngineService {
  /** 生效规则清单（只读子集）。 */
  list(): RuleSummary[];
  /** 引擎状态（规则条数、状态目录、注入上限）。 */
  status(): ReturnType<RuleEngine["status"]>;
}

/** 默认注入上限。 */
export const DEFAULT_MAX_INJECTIONS_PER_TURN = 3;

/**
 * DSH 宿主按 bundle 契约调用：惰性、防御，加载失败只告警不抛。
 * 自证日志写 stderr（cordis 的 inject 缺失是「等待」而非报错，插件静默不加载时靠它排查）。
 */
export async function apply(ctx: unknown, config?: Config): Promise<void> {
  const warn = (message: string): void => {
    process.stderr.write(`[rule-engine] warn: ${message}\n`);
  };
  const c = (ctx ?? {}) as PluginContext;
  try {
    const stateDir = config?.stateDir ?? defaultStateDir();
    const injector = createAgentInjector(
      { agents: c.agents, sessions: c.sessions },
      { warn },
    );
    const engine = new RuleEngine({
      baseline: config?.rules ?? [],
      stateDir,
      injector,
      maxInjectionsPerTurn:
        config?.maxInjectionsPerTurn ?? DEFAULT_MAX_INJECTIONS_PER_TURN,
      warn,
    });

    // 事件订阅：disposer 随插件 fiber 卸载自动回收（cordis 语义），此处不额外持有
    if (typeof c.on !== "function") {
      warn("ctx.on 不可用，规则不会随事件触发（工具族仍可管理规则）");
    } else {
      c.on("session/event", (session, event) => {
        engine.handle(session, event);
      });
    }

    // 工具族：缺 tools 时降级（核心事件订阅已生效）
    const tools = c.tools;
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
