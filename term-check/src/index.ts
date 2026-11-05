/**
 * term-check 插件入口（DSH bundle 接入面）。
 *
 * 角色：**rule-engine 的消费者** —— 启动时经 `inject: ["ruleEngine"]` 取得消费者注册面，注册
 * id `term-check`；rule-engine 在 `assistant-text`（`turn/end` 时派发的整回合助手正文）询问
 * `decide`：本插件按术语表快照检查正文里的旧称，命中就返回一条更正提示（交 rule-engine 统一
 * 注入，本插件不碰宿主注入面），没有就返回 null。**只报不改** —— 不改回复正文，也不改任何文件。
 *
 * 术语表是随包发布的构建期快照（`term-check/src/glossary.generated.ts`，由 `pnpm run gen:glossary` 生成），
 * 运行时不读工作区文件，故非本仓项目也能审查。
 *
 * 配置（`Config`）：`enabled`（缺省开启）/ `sources` / `delivery` / `dedupeInRecord`
 * （缺省 1：同一条提醒每会话只注入一次）/ `maxHits`。
 */

import { renderFeedback, type CheckOptions } from "./checker.ts";

export const name = "term-check";

/** 硬依赖：消费者注册面（rule-engine provide `ruleEngine`）。 */
export const inject = ["ruleEngine"];

/** 插件配置（类型声明，宿主不校验；缺省见 resolveConfig）。 */
export interface Config {
  /** 是否开启检查（缺省 `true`；显式 `false` 关闭）。 */
  enabled?: boolean;
  /** 唤醒节点（缺省 `["assistant-text"]`）。 */
  sources?: readonly string[];
  /** 投递方式（缺省 `"followup"` —— 作为新回合注入，模型据此重发修正后的回复）。 */
  delivery?: "steer" | "inject" | "followup";
  /** 按记录去重：投影里最多允许 N 条本反馈（缺省 `1` = 每会话一次）。 */
  dedupeInRecord?: number;
  /** 每条反馈最多列出几处（缺省 8；`0` = 不限）。 */
  maxHits?: number;
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  sources: readonly string[];
  delivery: "steer" | "inject" | "followup";
  dedupeInRecord: number;
  check: CheckOptions;
}

/** 归一化配置（非法值回退缺省，不抛错）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const sources =
    Array.isArray(config?.sources) && config.sources.length > 0
      ? config.sources.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
      : [];
  return {
    enabled: config?.enabled !== false,
    sources: sources.length > 0 ? sources : ["assistant-text"],
    delivery:
      config?.delivery === "inject" || config?.delivery === "steer"
        ? config.delivery
        : "followup",
    dedupeInRecord:
      typeof config?.dedupeInRecord === "number" &&
      Number.isFinite(config.dedupeInRecord) &&
      config.dedupeInRecord >= 0
        ? Math.floor(config.dedupeInRecord)
        : 1,
    check: {
      ...(typeof config?.maxHits === "number"
        ? { maxHits: config.maxHits }
        : {}),
    },
  };
}

/** rule-engine 消费者注册面（结构化类型，不 import 对方代码）。 */
interface ConsumerRegistrar {
  registerConsumer(input: {
    id: string;
    sources?: readonly string[];
    delivery?: string;
    dedupeInRecord?: number;
    decide: (context: {
      sessionId: string;
      turn: number;
      text: string;
      trigger: string;
    }) => { text: string; summary?: string } | null;
  }): () => void;
}

/** 插件上下文的结构化面（`ctx.ruleEngine` / `ctx.get('ruleEngine')`）。 */
interface PluginContext {
  ruleEngine?: ConsumerRegistrar;
  get?: (name: string) => unknown;
}

/**
 * 挂载：把自身注册为 rule-engine 消费者；开启时对每条回合正文做术语检查，有旧称就返回更正提示。
 * 返回 dispose（注销消费者）；rule-engine 缺席 → 告警且不注册（本包不因此让宿主启动失败）。
 */
export function apply(ctx: unknown, config?: Config): () => void {
  const warn = (message: string): void => {
    process.stderr.write(`[term-check] warn: ${message}\n`);
  };
  const resolved = resolveConfig(config);
  const c = (ctx ?? {}) as PluginContext;
  const engine =
    c.ruleEngine ??
    (typeof c.get === "function"
      ? (c.get("ruleEngine") as ConsumerRegistrar | undefined)
      : undefined);
  if (engine === undefined || typeof engine.registerConsumer !== "function") {
    warn(
      "ctx.ruleEngine 不可用，术语检查不会触发（请检查 rule-engine 是否挂载）",
    );
    return () => {};
  }
  try {
    return engine.registerConsumer({
      id: name,
      sources: resolved.sources,
      delivery: resolved.delivery,
      dedupeInRecord: resolved.dedupeInRecord,
      decide: (context) =>
        resolved.enabled ? renderFeedback(context.text, resolved.check) : null,
    });
  } catch (error) {
    warn(`注册消费者失败：${String(error)}`);
    return () => {};
  }
}
