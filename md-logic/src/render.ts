// src/render.ts — 工具面文本渲染（模型侧唯一可见面；工具 JSON 值不直接面向模型）。
// 口径：行号 1 基、范围 `L{起}-{止}`（起止相同折叠为 `L{n}`）、每类独立 80 行预算并带省略标记。

import { flattenSections } from "./query.ts";
import type { MdBlock, MdLink, MarkdownDocument } from "./types.ts";

/** 每类渲染的行上限。 */
export const RENDER_LIMIT = 80;

/** 行范围文本：`L1` 或 `L1-20`。 */
function range(line: number, endLine: number): string {
  return endLine === line ? `L${line}` : `L${line}-${endLine}`;
}

/** 截断收尾。 */
function cap(lines: string[]): string[] {
  if (lines.length <= RENDER_LIMIT) return lines;
  return [
    ...lines.slice(0, RENDER_LIMIT),
    `…（其余 ${lines.length - RENDER_LIMIT} 条略）`,
  ];
}

/** 结构总览 + 节树（默认展示到第 `depth` 层）。 */
export function renderStructure(doc: MarkdownDocument, depth = 3): string {
  const flat = flattenSections(doc.sections);
  const head = `Markdown 结构：${doc.lines} 行 / ${flat.length} 节 / ${doc.blocks.length} 块 / ${doc.links.length} 链接`;
  const lines: string[] = [];
  for (const node of flat) {
    if (node.depth > depth) continue;
    lines.push(
      `${"  ".repeat(node.depth - 1)}${range(node.line, node.endLine)} h${node.level} ${node.title}`,
    );
  }
  const body = cap(lines);
  if (body.length === 0) body.push("(无标题；用 blocks 看块结构)");
  return [head, ...body].join("\n");
}

/** 块清单（带节归属 `§L{节标题行}`）。 */
export function renderBlocks(blocks: MdBlock[]): string {
  const lines = blocks.map((block) => {
    const where = block.section === undefined ? "" : `§L${block.section} `;
    const suffix =
      block.kind === "list"
        ? `·${block.count ?? 0}项·d${block.depth ?? 1}`
        : block.kind === "table"
          ? `·${block.count ?? 0}行×${block.cols ?? 0}列`
          : block.kind === "code"
            ? block.lang === undefined
              ? ""
              : `·${block.lang}`
            : block.kind === "quote"
              ? `·${block.count ?? 0}行·d${block.depth ?? 1}`
              : block.kind === "frontmatter"
                ? `·${block.count ?? 0}键`
                : "";
    return `${where}${range(block.line, block.endLine)} ${block.kind}${suffix}`;
  });
  return cap(lines).join("\n");
}

/** 链接清单。 */
export function renderLinks(links: MdLink[]): string {
  const lines = links.map((link) => {
    const where = link.section === undefined ? "" : `§L${link.section} `;
    const title = link.title === undefined ? "" : ` "(${link.title})"`;
    const label =
      link.kind === "definition" ? `[${link.text}]` : `"${link.text}"`;
    return `${where}L${link.line} ${link.kind} ${label} → ${link.href}${title}`;
  });
  return cap(lines).join("\n");
}
