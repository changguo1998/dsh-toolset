/**
 * symbol-normalizer 类型：配置、审查结果与对外服务面。
 *
 * 语义对齐 README：
 * - 展示层归一 = `normalize(text)`（别名替换 + 报告，无副作用）；
 * - 回合审查 = 逐符号冷却过滤后的「人类 notice + 模型反馈」（review.ts）；
 * - 消费者接入 = 启动时把审查注册进 rule-engine（反馈由 rule-engine 注入）。
 */

import type { NormalizeResult, SymbolRulesConfig } from "./symbols.ts";

/** 插件配置（profile `cordis.patch.yml` 的 config 段；无运行时 schema，宿主原样透传）。 */
export type Config = SymbolRulesConfig;

/** 一次回合审查的结果（冷却过滤后）。 */
export interface ReviewResult {
  /** 人类 notice 文案（一行）。 */
  notice: string;
  /** 模型反馈文案；`warnModel` 关闭时为 null（只提示人、不提醒模型）。 */
  feedback: string | null;
}

/** 审查事件（经服务 `onReview` 推给展示层）。 */
export interface ReviewEvent extends ReviewResult {
  sessionId: string;
}

/** `provide("symbolNormalizer")` 服务面（供 TUI 等展示层消费）。 */
export interface SymbolNormalizerService {
  /** 展示层归一：别名替换 + 报告（无副作用）。 */
  normalize(text: string): NormalizeResult;
  /** 订阅审查事件（notice 展示用）；返回注销函数。 */
  onReview(listener: (event: ReviewEvent) => void): () => void;
  /** 只读状态。 */
  status(): {
    /** 推荐白名单条数（内置 + 配置）。 */
    recommended: number;
    /** 别名表条数（内置 + 配置）。 */
    aliases: number;
    warnModel: boolean;
    cooldownMs: number;
    cooldownRuns: number;
    /** 当前有冷却记账的会话数。 */
    sessions: number;
  };
}
