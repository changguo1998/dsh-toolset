/**
 * 会话开局「符号规范」指南（BACKLOG F2）：
 * - `buildSymbolGuide`：**全部文本由 config 生成**（推荐白名单与别名映射取自 `ResolvedSymbolRules`，不硬编码符号表）；
 * - `SymbolGuideGate`：每会话只注入一次的门控（进程内记账，容量上限做 FIFO 淘汰，避免长跑进程无限增长）。
 *
 * 注入路径：rule-engine 消费者（与回合审查同一通道，受 `maxInjectionsPerTurn` 保护）。
 * 注：宿主指令面（`@deepseek-ai/dsh-agent-instructions`）只读取固定候选路径的指令文件，
 * 无插件注册口，故「严格早于首个请求」不可达；本指南在首个可行回合边界注入（见追踪文档）。
 */

import type { ResolvedSymbolRules } from "./symbols.ts";

/** 摘要行（rule-engine notice 呈现用）。 */
export const GUIDE_SUMMARY = "符号规范（会话开局指南）";

/** rule-engine 注入消息的来源标识（识别历史指南用；结构面常量，不引跨包依赖）。 */
export const RULE_ENGINE_SOURCE_KIND = "rule-engine";

/**
 * 会话历史里是否已有本指南消息（F3 跨重启去重）：按 `source.kind + summary` 识别，
 * 与 rule-engine 的注入形态一致（`rule-engine/src/inject.ts` 的 `source`）。
 */
export function hasGuideMessage(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    const source = (
      message as { source?: { kind?: unknown; summary?: unknown } } | null
    )?.source;
    return (
      source?.kind === RULE_ENGINE_SOURCE_KIND &&
      source?.summary === GUIDE_SUMMARY
    );
  });
}

/** 别名映射最多列出的条数（正文长度可控）。 */
const MAX_ALIAS_ENTRIES = 20;

/**
 * 生成会话开局指南正文：推荐白名单 + 使用标准（变体对应、禁止 emoji、场景口径、代码段豁免）。
 * 变体映射写成行内代码（`` `❌→✗` ``），避免指南自身触发符号审查。
 */
export function buildSymbolGuide(rules: ResolvedSymbolRules): string {
  const recommended = [...rules.recommendedSet].join(" ");
  const pairs = Object.entries(rules.aliases).slice(0, MAX_ALIAS_ENTRIES);
  const aliasText = pairs.map(([from, to]) => `\`${from}→${to}\``).join("、");
  return [
    "[符号规范] 会话开局指南（按此输出，避免回合末返工）：",
    `1) 推荐符号白名单（几何简单、列宽确定、无填色）：${recommended}`,
    `2) 有推荐对应关系的变体必须改用推荐符（展示层会替换，但会话记录保留原文）：${aliasText}`,
    "3) 禁止 emoji 与列宽不定/带填色的图形字符，也不要自造符号。",
    "4) 使用场景：状态 / 方向 / 几何类用推荐符号或文字；装饰性强调用文字，不用符号凑数。",
    "5) 行内代码与围栏代码块内的符号是引用示例，不参与审查（无需改写）。",
  ].join("\n");
}

/** 每会话一次注入门控（容量上限 FIFO 淘汰）。 */
export class SymbolGuideGate {
  readonly #seen = new Set<string>();
  readonly #cap: number;

  constructor(cap = 256) {
    this.#cap = cap;
  }

  /** 首次为该会话调用返回 true（此后 false）。 */
  take(sessionId: string): boolean {
    if (this.#seen.has(sessionId)) return false;
    this.#seen.add(sessionId);
    if (this.#seen.size > this.#cap) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return true;
  }

  /** 是否已记账（只读；F3：历史判定命中后记账、后续走快路径）。 */
  has(sessionId: string): boolean {
    return this.#seen.has(sessionId);
  }

  /** 当前记账的会话数（测试与诊断用）。 */
  size(): number {
    return this.#seen.size;
  }
}
