/**
 * 会话开局「符号规范」指南（BACKLOG F2）：
 * - `buildSymbolGuide`：**全部文本由 config 生成**（推荐白名单与别名映射取自 `ResolvedSymbolRules`，不硬编码符号表）。
 *
 * 注入路径：rule-engine 消费者（与回合审查同一通道，受 `maxInjectionsPerTurn` 保护）。
 * 触发与去重按 rule-engine 的统一标准：注册 `sources: ["step-end"]` + `dedupeInRecord: 1`
 * （可见投影里最多 1 条）——开局注入一次，压缩把注入挤出投影后自然补一次。
 * `delivery: "steer"` 与 skill 自加载规则同节点同组：同一次 `step-end` 触发下合并为一条注入。
 * 注：宿主指令面（`@deepseek-ai/dsh-agent-instructions`）只读取固定候选路径的指令文件，
 * 无插件注册口，故「严格早于首个请求」不可达；本指南在首个可行回合边界注入（见追踪文档）。
 */

import type { ResolvedSymbolRules } from "./symbols.ts";

/** 摘要行（rule-engine notice 呈现用）。 */
export const GUIDE_SUMMARY = "符号规范（会话开局指南）";

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
