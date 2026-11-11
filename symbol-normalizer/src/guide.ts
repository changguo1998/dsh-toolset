/**
 * 会话开局「符号规范」指南：
 * - `buildSymbolGuide`：**全部文本由 config 生成**（推荐白名单与别名映射取自 `ResolvedSymbolRules`，不硬编码符号表）。
 *
 * 注入路径：**静态保持** —— 由插件入口直接注册 `ctx.systemPrompt.section`（system node 0）,
 * name `symbol-normalizer/guide`、order 4000、`interpolate: false`; 压缩豁免, 每步恒在.
 * 内容随 config 只在重启后生效；`injectGuide: false` 时不注册.
 * 注：宿主指令面（`@deepseek-ai/dsh-agent-instructions`）只读取固定候选路径的指令文件,
 * 无插件注册口；本指南经 system prompt 面常驻, 不再走消息级一次性通道（见追踪文档）.
 * `GUIDE_SUMMARY` 仅供展示层识别, 注入链路不再使用.
 */

import type { ResolvedSymbolRules } from "./symbols.ts";

/** 摘要行（注入消息的 `source.summary`；rule-engine 按此 key 计 `dedupeInRecord`）。 */
export const GUIDE_SUMMARY = "符号规范（会话开局指南）";

/** 别名映射最多列出的条数（正文长度可控）。 */
const MAX_ALIAS_ENTRIES = 20;

/**
 * 生成会话开局指南正文：**只有命令与要求**（无标题、除示例外无解释性括注），且**泛化规则在前、
 * 具体清单在后**（禁止项 / 使用场景 / 标点与间距 → 白名单 → 变体映射 → 代码段豁免）。
 * 变体映射与示例写成行内代码（`` `❌→✗` ``），避免指南自身触发符号审查。
 */
export function buildSymbolGuide(rules: ResolvedSymbolRules): string {
  const recommended = [...rules.recommendedSet].join(" ");
  const pairs = Object.entries(rules.aliases).slice(0, MAX_ALIAS_ENTRIES);
  const aliasText = pairs.map(([from, to]) => `\`${from}→${to}\``).join("、");
  return [
    "[符号规范]",
    "1. 禁止 emoji 与列宽不定 / 带填色的图形字符；不要自造符号。",
    "2. 状态 / 方向 / 几何类用推荐符号或文字；装饰性强调用文字。",
    "3. 中文标点（`，。；：！？`）改用英文标点，且标点后留一个空格（`，好` 写 `, 好`）。",
    "4. 非 ASCII 符号（几何 / 状态 / 圈点 / 箭头等）后留一个空格，不紧贴文字（`✓完成` 写 `✓ 完成`）。",
    `5. 推荐符号白名单：${recommended}`,
    `6. 下列变体必须改用推荐符：${aliasText}`,
    "7. 行内代码与围栏代码块内的符号不参与审查；其余正文仍须写推荐符号。",
    "",
    "若本会话有正在进行的工作, 了解后继续原任务; 否则停下等待指令, 不要自行去工作区找任务.",
  ].join("\n");
}
