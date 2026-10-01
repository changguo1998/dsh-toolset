/**
 * symbol-normalizer 插件入口（DSH bundle 接入面）。
 *
 * 角色：**rule-engine 的消费者**（框架第一个验证插件）——
 * 启动时经 `inject: ["ruleEngine"]` 获得消费者注册面，注册 id `symbol-normalizer`；
 * rule-engine 在 turn-end 询问 `decide`：
 *   1. 对整回合正文做符号审查（逐符号冷却）；
 *   2. 命中时把人类 notice 经服务 `onReview` 推给展示层（TUI）；
 *   3. 返回模型反馈内容，由 rule-engine **统一注入**（本插件不碰宿主注入面）。
 *
 * 同时 provide `symbolNormalizer` 服务供 TUI 做展示层归一（`normalize`）。
 *
 * 配置（`Config`）：`recommended` / `aliases` / `warnModel` / `cooldownMs` / `cooldownRuns`
 * （自 TUI `tui.config.json` 的 `symbols` 段迁移；无运行时 schema，宿主原样透传）。
 */

import { SymbolReviewer } from "./review.ts";
import { normalizeSymbols, resolveSymbolRules } from "./symbols.ts";
import { GUIDE_SUMMARY, buildSymbolGuide } from "./guide.ts";
import type { Config, ReviewEvent, SymbolNormalizerService } from "./types.ts";

export const name = "symbol-normalizer";

/** 硬依赖：消费者注册面（rule-engine provide `ruleEngine`）。 */
export const inject = ["ruleEngine"];

/** 提供的服务名（TUI 等展示层经 `ctx.get('symbolNormalizer')` 消费）。 */
export const provide = ["symbolNormalizer"];

/** 反馈摘要（宿主 `form:'notice'` 呈现的一行摘要）。 */
export const FEEDBACK_SUMMARY = "符号规范提醒";

export { SymbolReviewer } from "./review.ts";
export type { ReviewerOptions } from "./review.ts";
export {
  DEFAULT_ALIASES,
  DEFAULT_RECOMMENDED,
  DEFAULT_SYMBOL_COOLDOWN_MS,
  DEFAULT_SYMBOL_COOLDOWN_RUNS,
  normalizeSymbols,
  resolveSymbolRules,
} from "./symbols.ts";
export type {
  NormalizeResult,
  ResolvedSymbolRules,
  SymbolRemap,
  SymbolRulesConfig,
} from "./symbols.ts";
export type {
  Config,
  ReviewEvent,
  ReviewResult,
  SymbolNormalizerService,
} from "./types.ts";

/** rule-engine 消费者注册面最小形态（结构面访问，不引入跨包依赖）。 */
interface ConsumerRegistrar {
  registerConsumer(input: {
    id: string;
    /** 唤醒时机（节点表）；缺省 `["turn-end"]`。 */
    sources?: readonly string[];
    /** 按记录去重：投影里最多允许 N 条本反馈（0 = 无限制，缺省）。 */
    dedupeInRecord?: number;
    decide(context: {
      sessionId: string;
      turn: number;
      text: string;
      trigger: string;
    }): { text: string; summary?: string; reset?: boolean } | null;
  }): () => void;
}

/** ctx 结构面（只声明本插件用到的成员）。 */
interface PluginContext {
  ruleEngine?: ConsumerRegistrar;
  provide?: (name: string, value: unknown) => unknown;
  effect?: (fn: () => unknown) => unknown;
}

/**
 * DSH 宿主按 bundle 契约调用：惰性、防御，加载失败只告警不抛。
 * 自证日志写 stderr（`inject` 缺失时 cordis 语义是「等待」而非报错）。
 */
export async function apply(ctx: unknown, config?: Config): Promise<void> {
  const warn = (message: string): void => {
    process.stderr.write(`[symbol-normalizer] warn: ${message}\n`);
  };
  const c = (ctx ?? {}) as PluginContext;
  try {
    const rules = resolveSymbolRules(config);
    const reviewer = new SymbolReviewer({ rules });
    const listeners = new Set<(event: ReviewEvent) => void>();
    const emit = (event: ReviewEvent): void => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          warn(`onReview 监听器抛错：${String(err)}`);
        }
      }
    };

    // 消费者接入：decide 内审查 → notice 推展示层；反馈交由 rule-engine 注入
    let dispose: (() => void) | undefined;
    const engine = c.ruleEngine;
    if (engine === undefined || typeof engine.registerConsumer !== "function") {
      warn(
        "ctx.ruleEngine 不可用，符号提醒不会触发（展示层归一仍可用；请检查 rule-engine 是否挂载）",
      );
    } else {
      try {
        dispose = engine.registerConsumer({
          id: "symbol-normalizer",
          decide: (context) => {
            const result = reviewer.review(context.sessionId, context.text);
            if (result === null) return null;
            emit({
              sessionId: context.sessionId,
              notice: result.notice,
              feedback: result.feedback,
            });
            if (result.feedback === null) return null;
            return { text: result.feedback, summary: FEEDBACK_SUMMARY };
          },
        });
      } catch (err) {
        warn(`消费者注册失败：${String(err)}`);
      }
    }

    // 会话开局指南（BACKLOG F2）：每会话一次注入「推荐白名单 + 使用标准」。
    // 去重与补注入交给 rule-engine 统一标准：`dedupeInRecord: 1`（可见投影里最多 1 条，
    // 被压缩挤出后由 `compaction` 节点补一次；`turn-end` 用于跨重启判空），不再自管 gate。
    let disposeGuide: (() => void) | undefined;
    if (
      engine !== undefined &&
      typeof engine.registerConsumer === "function" &&
      rules.injectGuide
    ) {
      try {
        disposeGuide = engine.registerConsumer({
          id: "symbol-normalizer-guide",
          sources: ["turn-end", "compaction"],
          dedupeInRecord: 1,
          decide: () => ({
            text: buildSymbolGuide(rules),
            summary: GUIDE_SUMMARY,
          }),
        });
      } catch (err) {
        warn(`开局指南消费者注册失败：${String(err)}`);
      }
    }

    // 展示层服务：normalize / onReview / status
    if (typeof c.provide === "function") {
      try {
        c.provide("symbolNormalizer", {
          normalize: (text: string) => normalizeSymbols(text, rules),
          onReview: (listener: (event: ReviewEvent) => void) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          status: () => ({
            recommended: rules.recommendedSet.size,
            aliases: Object.keys(rules.aliases).length,
            warnModel: rules.warnModel,
            cooldownMs: rules.cooldownMs,
            cooldownRuns: rules.cooldownRuns,
            sessions: reviewer.sessionCount(),
          }),
        } satisfies SymbolNormalizerService);
      } catch (err) {
        warn(`提供 symbolNormalizer 服务失败：${String(err)}`);
      }
    }

    // cordis 生命周期：插件卸载时注销消费者（disposer 归 cordis 管理）
    c.effect?.(() => () => {
      dispose?.();
      disposeGuide?.();
    });

    process.stderr.write(
      `[symbol-normalizer] 已加载：推荐 ${rules.recommendedSet.size} 条 / 别名 ${Object.keys(rules.aliases).length} 条，warnModel=${rules.warnModel}，冷却 ${rules.cooldownMs}ms/${rules.cooldownRuns}run\n`,
    );
  } catch (err) {
    warn(`初始化失败：${String(err)}`);
  }
}
