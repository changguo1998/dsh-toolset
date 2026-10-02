// src/render.ts — fs_digest 工具结果的文本渲染（模型侧唯一可见面；工具 JSON 值不直接面向模型）。
// 预算：标题树与块清单**各有独立上限**，避免大文档时块清单被树挤掉；超出各自打省略标记。

import type { MdBlock, OutlineNode } from "./types.ts";

/** 标题树渲染行预算。 */
export const OUTLINE_TREE_BUDGET = 45;
/** 块清单渲染行预算（不含表头行）。 */
export const OUTLINE_BLOCK_BUDGET = 15;

/** `L{line}` 或 `L{line}-{endLine}`（endLine 缺失或等于 line 时只显示起始行）。 */
function lineRange(line: number, endLine?: number): string {
  return endLine === undefined || endLine === line
    ? `${line}`
    : `${line}-${endLine}`;
}

/** 块清单行：`§L{section} L{line}-{endLine} kind·计数`（section 缺失时不显示归属）。 */
function formatBlock(block: MdBlock): string {
  const where = block.section === undefined ? "" : `§L${block.section} `;
  const count = block.count ?? 0;
  const suffix =
    block.kind === "code"
      ? block.lang === undefined
        ? ""
        : `·${block.lang}`
      : block.kind === "list"
        ? `·${count}项`
        : block.kind === "frontmatter"
          ? `·${count}键`
          : `·${count}行`;
  return `${where}L${lineRange(block.line, block.endLine)} ${block.kind}${suffix}`;
}

/** 渲染 outline：标题树（带行范围）+ 块清单（带节归属）。 */
export function renderOutline(
  nodes: readonly OutlineNode[],
  blocks: readonly MdBlock[] | undefined,
  treeBudget: number = OUTLINE_TREE_BUDGET,
  blockBudget: number = OUTLINE_BLOCK_BUDGET,
): string {
  const lines: string[] = [];
  let overflow = false;
  const walk = (list: readonly OutlineNode[], level: number): void => {
    for (const node of list) {
      if (lines.length >= treeBudget) {
        overflow = true;
        return;
      }
      lines.push(
        `${"  ".repeat(level - 1)}L${lineRange(node.line, node.endLine)} ${node.kind} ${node.name}`,
      );
      walk(node.children, level + 1);
      if (overflow) return;
    }
  };
  walk(nodes, 1);
  if (overflow) lines.push("…（其余标题略）");

  const all = blocks ?? [];
  if (all.length > 0) {
    const shown = all.slice(0, blockBudget);
    lines.push(`块结构（${all.length} 个）：`);
    for (const block of shown) lines.push(formatBlock(block));
    if (all.length > shown.length) {
      lines.push(`…（另有 ${all.length - shown.length} 个块未列）`);
    }
  }
  return lines.length === 0 ? "(空大纲)" : lines.join("\n");
}
