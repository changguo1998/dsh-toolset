/**
 * ponytail — 把上游 ponytail 的「懒资深工程师」决策阶梯做成可开关的**静态保持**内容。
 *
 * 形态：apply 时直接注册 `ctx.systemPrompt.section({ name: "ponytail/ladder", order: 4100, ... })`
 * —— 系统提示 node 0 常驻、压缩豁免，不再走 rule-engine 的消息级一次性通道。
 * 缺省**开启**（仅显式 `enabled: false` 关闭）；关闭时不注册 section。
 * **不搬**上游的 `hooks/*.js` / `commands/*.toml` / `gemini-extension.json`（DSH 无该面）。
 *
 * 调研结论与取舍见 `docs/ponytail-investigation.md`（项目级）与 `ponytail/docs/DESIGN.md`（本包）。
 */

import { LADDER_TEXT } from "./ladder.ts";

export const name = "ponytail";

/** 依赖：静态保持的 system prompt section 面。 */
export const inject = ["systemPrompt"];

/** 插件配置（类型声明，宿主不校验；缺省见 resolveConfig）。 */
export interface Config {
  /** 是否开启注入（缺省 `true` —— 默认开启；仅显式 `false` 关闭）。 */
  enabled?: boolean;
  /** 覆盖注入正文（缺省 `LADDER_TEXT`；用于本地试验）。 */
  text?: string;
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  text: string;
}

/** 归一化配置（非法值回退缺省，不抛错）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  return {
    enabled: config?.enabled !== false,
    text:
      typeof config?.text === "string" && config.text.length > 0
        ? config.text
        : LADDER_TEXT,
  };
}

/** 插件上下文的结构化面（只声明本插件用到的成员）。 */
interface PluginContext {
  systemPrompt?: {
    section?(section: {
      name: string;
      order: number;
      text: string;
      interpolate?: boolean;
    }): () => void;
  };
}

/**
 * 挂载：开启时注册静态 section；关闭时不注册，返回空操作 dispose。
 * systemPrompt 缺席 → 告警且不注册（本包不因此让宿主启动失败）。
 */
export function apply(ctx: unknown, config?: Config): () => void {
  const warn = (message: string): void => {
    process.stderr.write(`[ponytail] warn: ${message}\n`);
  };
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return () => {};
  const c = (ctx ?? {}) as PluginContext;
  const systemPrompt = c.systemPrompt;
  if (typeof systemPrompt?.section !== "function") {
    warn("ctx.systemPrompt 不可用，ponytail 阶梯不会注入（请检查宿主版本）");
    return () => {};
  }
  try {
    return systemPrompt.section({
      name: "ponytail/ladder",
      order: 4100,
      text: resolved.text,
      interpolate: false,
    });
  } catch (error) {
    warn(`注册 section 失败：${String(error)}`);
    return () => {};
  }
}
