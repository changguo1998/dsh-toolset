/**
 * ponytail — 把上游 ponytail 的「懒资深工程师」决策阶梯做成可开关的**上下文注入**（BACKLOG 条目）。
 *
 * 姿态：与 `symbol-normalizer` 同款 —— `inject: ["ruleEngine"]`，apply 时把自身注册为 rule-engine 的
 * **消费者**（`registerConsumer`）；开启时在 `session-start` 注入阶梯正文，关闭时 `decide` 返回 null
 * （不注入）。**不搬**上游的 `hooks/*.js` / `commands/*.toml` / `gemini-extension.json`（DSH 无该面）。
 *
 * 缺省**关闭**：与 `karpathy-guidelines` 的「简单优先 / 外科手术式改动」高度重叠，默认不双份注入。
 * 调研结论与取舍见 `docs/ponytail-investigation.md`（项目级）与 `docs/DESIGN.md`（本包）。
 */

import { LADDER_SUMMARY, LADDER_TEXT } from "./ladder.ts";

export const name = "ponytail";

/** 硬依赖：消费者注册面（rule-engine provide `ruleEngine`）。 */
export const inject = ["ruleEngine"];

/** 插件配置（类型声明，宿主不校验；缺省见 resolveConfig）。 */
export interface Config {
  /** 是否开启注入（缺省 `false` —— 默认关闭，避免与 karpathy-guidelines 双份注入）。 */
  enabled?: boolean;
  /** 唤醒节点（缺省 `["session-start", "step-end"]` —— 后者作兜底，防真机「非 live 跳过」）。 */
  sources?: readonly string[];
  /** 投递方式（缺省 `"steer"`；`inject` 不唤醒、真机上 agent 非 live 时会被丢弃）。 */
  delivery?: "steer" | "inject" | "followup";
  /** 按记录去重：投影里最多允许 N 条本注入（缺省 1）。 */
  dedupeInRecord?: number;
  /** 覆盖注入正文（缺省 `LADDER_TEXT`；用于本地试验）。 */
  text?: string;
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  sources: readonly string[];
  delivery: "steer" | "inject" | "followup";
  dedupeInRecord: number;
  text: string;
}

/** 归一化配置（非法值回退缺省，不抛错）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const sources =
    Array.isArray(config?.sources) && config.sources.length > 0
      ? config.sources.filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        )
      : ["session-start", "step-end"];
  return {
    enabled: config?.enabled === true,
    sources: sources.length > 0 ? sources : ["session-start", "step-end"],
    delivery:
      config?.delivery === "inject" || config?.delivery === "followup"
        ? config.delivery
        : "steer",
    dedupeInRecord:
      typeof config?.dedupeInRecord === "number" && config.dedupeInRecord >= 0
        ? config.dedupeInRecord
        : 1,
    text:
      typeof config?.text === "string" && config.text.length > 0
        ? config.text
        : LADDER_TEXT,
  };
}

/** rule-engine 消费者注册面（结构化类型，不 import 对方代码）。 */
interface RuleEngineLike {
  registerConsumer(input: {
    id: string;
    sources?: readonly string[];
    delivery?: string;
    dedupeInRecord?: number;
    directWrite?: readonly string[];
    decide: (context: { sessionId: string; turn: number; text?: string }) => {
      text: string;
      summary?: string;
    } | null;
  }): () => void;
}

/** 插件上下文的结构化面（`ctx.get('ruleEngine')`）。 */
interface PluginContext {
  ruleEngine?: RuleEngineLike;
  get?: (name: string) => unknown;
}

/**
 * 挂载：把自身注册为 rule-engine 消费者；开启时在 `sources` 节点返回阶梯正文。
 * 返回 dispose（注销消费者）；rule-engine 缺席 → 告警且不注册（本包不因此让宿主启动失败）。
 */
export function apply(ctx: unknown, config?: Config): () => void {
  const warn = (message: string): void => {
    process.stderr.write(`[ponytail] warn: ${message}\n`);
  };
  const resolved = resolveConfig(config);
  const c = (ctx ?? {}) as PluginContext;
  const engine =
    c.ruleEngine ??
    (typeof c.get === "function"
      ? (c.get("ruleEngine") as RuleEngineLike | undefined)
      : undefined);
  if (engine === undefined || typeof engine.registerConsumer !== "function") {
    warn(
      "ctx.ruleEngine 不可用，ponytail 阶梯不会注入（请检查 rule-engine 是否挂载）",
    );
    return () => {};
  }
  try {
    return engine.registerConsumer({
      id: "ponytail",
      sources: resolved.sources,
      delivery: resolved.delivery,
      dedupeInRecord: resolved.dedupeInRecord,
      decide: () =>
        resolved.enabled
          ? { text: resolved.text, summary: LADDER_SUMMARY }
          : null,
    });
  } catch (error) {
    warn(`注册消费者失败：${String(error)}`);
    return () => {};
  }
}
