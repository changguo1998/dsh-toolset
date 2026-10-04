/**
 * 会话开局「符号规范」指南：
 * - `buildSymbolGuide`：**全部文本由 config 生成**（推荐白名单与别名映射取自 `ResolvedSymbolRules`，不硬编码符号表）。
 *
 * 注入路径：rule-engine 消费者（与回合审查同一通道，受 `maxInjectionsPerTurn` 保护）。
 * 触发与去重按 rule-engine 的统一标准：注册 `sources: ["session-start", "compaction", "step-end"]`
 * + `dedupeInRecord: 1` + `directWrite: ["session-start", "compaction"]`——会话建立（含恢复）与
 * 压缩完成直写（跳过记录去重判断，故恢复会话会再注入一次），步末按会话记录判断
 * （可见投影 + 未消费 inbox；最多 1 条，被压缩挤出后补回）。
 * `delivery: "steer"` 与 skill 自加载规则同节点同组：同一次触发下合并为一条注入。
 * 注：宿主指令面（`@deepseek-ai/dsh-agent-instructions`）只读取固定候选路径的指令文件，
 * 无插件注册口，故「严格早于首个请求」不可达；本指南在首个可行回合边界注入（见追踪文档）。
 */

import type { ResolvedSymbolRules } from "./symbols.ts";

/** 摘要行（注入消息的 `source.summary`；rule-engine 按此 key 计 `dedupeInRecord`）。 */
export const GUIDE_SUMMARY = "符号规范（会话开局指南）";

/** 别名映射最多列出的条数（正文长度可控）。 */
const MAX_ALIAS_ENTRIES = 20;

/**
 * 生成会话开局指南正文：**只有命令与要求**（无标题、无解释性括注），且**泛化规则在前、
 * 具体清单在后**（禁止项 / 使用场景 → 白名单 → 变体映射 → 代码段豁免）。
 * 变体映射写成行内代码（`` `❌→✗` ``），避免指南自身触发符号审查。
 */
export function buildSymbolGuide(rules: ResolvedSymbolRules): string {
  const recommended = [...rules.recommendedSet].join(" ");
  const pairs = Object.entries(rules.aliases).slice(0, MAX_ALIAS_ENTRIES);
  const aliasText = pairs.map(([from, to]) => `\`${from}→${to}\``).join("、");
  return [
    "[符号规范]",
    "1. 禁止 emoji 与列宽不定 / 带填色的图形字符；不要自造符号。",
    "2. 状态 / 方向 / 几何类用推荐符号或文字；装饰性强调用文字。",
    `3. 推荐符号白名单：${recommended}`,
    `4. 下列变体必须改用推荐符：${aliasText}`,
    "5. 行内代码与围栏代码块内的符号不参与审查；其余正文仍须写推荐符号。",
  ].join("\n");
}
