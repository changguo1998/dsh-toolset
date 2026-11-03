// dev/standard/markdown.mjs — Markdown 文本抽取（保留行号）与表格列数解析

import { splitCells } from "./rules.mjs";

/**
 * 把不参与检查的部分抹成空格（保持字符数与行号）：
 * front matter、围栏代码块、HTML 注释、行内代码、链接地址、裸 URL 与引用式定义地址。
 */
export function maskMarkdown(text) {
  const lines = text.split("\n");
  const out = [];
  let frontMatter = lines[0]?.trim() === "---";
  let inFence = false;
  let inComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (frontMatter) {
      if (i > 0 && line.trim() === "---") frontMatter = false;
      out.push(blank(line));
      continue;
    }
    if (inFence) {
      if (/^\s*(```|~~~)/.test(line)) inFence = false;
      out.push(blank(line));
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = true;
      out.push(blank(line));
      continue;
    }
    const comment = maskComment(line, inComment);
    inComment = comment.open;
    out.push(maskInline(comment.text));
  }
  return out.join("\n");
}

/** 逐字符抹掉 HTML 注释，返回抹好的行与跨行状态。 */
function maskComment(line, isOpen) {
  const chars = [...line];
  const out = [];
  let open = isOpen;
  for (let k = 0; k < chars.length; k += 1) {
    if (open) {
      if (chars.slice(k, k + 3).join("") === "-->") {
        out.push("   ");
        k += 2;
        open = false;
        continue;
      }
      out.push(chars[k] === "\t" ? "\t" : " ");
      continue;
    }
    if (chars.slice(k, k + 4).join("") === "<!--") {
      out.push("    ");
      k += 3;
      open = true;
      continue;
    }
    out.push(chars[k]);
  }
  return { text: out.join(""), open };
}

/** 行内: 抹掉 `代码`、链接地址、裸 URL。 */
function maskInline(line) {
  return line
    .replace(/`+[^`]*`+/g, (m) => blank(m))
    .replace(/\]\([^)]*\)/g, (m) => "]" + blank(m.slice(1)))
    .replace(
      /^(\s*\[[^\]]+\]:\s*)(\S+)$/g,
      (_m, lead, url) => lead + blank(url),
    )
    .replace(/\b(?:https?|mailto):\S+/g, (m) => blank(m));
}

/** 与原文等长的空格串（保留换行符）。 */
function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

/** 逐行表格列数: 表头、分隔行与数据行必须同宽。 */
export function tableIssues(text) {
  const lines = text.split("\n");
  const issues = [];
  let inTable = false;
  let width;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    const raw = lines[i] ?? "";
    // 只认顶格表格: 缩进行多半是缩进代码块（例如 SPEC 里贴的 TypeScript 联合类型）
    if (!raw.startsWith("|")) {
      inTable = false;
      width = undefined;
      continue;
    }
    const cells = splitCells(maskInlineCode(trimmed)).length;
    const isSeparator =
      /^\|[:\-\s|]+\|$/.test(trimmed) && trimmed.includes("-");
    if (!inTable) {
      inTable = true;
      width = cells;
      continue;
    }
    if (cells !== width)
      issues.push({
        line: i + 1,
        expected: width,
        got: cells,
        separator: isSeparator,
      });
  }
  return issues;
}

/** 收集 Markdown 链接目标（行内链接；围栏代码块与行内代码里的不收集）。 */
export function collectLinks(text) {
  const links = [];
  const lines = maskCodeLines(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = maskInlineCode(lines[i] ?? "");
    for (const match of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      links.push({ line: i + 1, target: match[1] });
    }
  }
  return links;
}

/** 行内代码抹成等长占位（连 `|` 一起盖掉），供表格切格与链接扫描。 */
function maskInlineCode(line) {
  return line.replace(/`+[^`]*`+/g, (m) => "x".repeat(m.length));
}

/** 保留正文、抹掉围栏代码块行（只为链接与标题扫描服务）。 */
function maskCodeLines(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out.join("\n");
}

/** Markdown 标题文本（不含 `#` 前缀），跳过围栏代码块。 */
export function headings(text) {
  const result = [];
  for (const line of maskCodeLines(text).split("\n")) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) result.push((match[2] ?? "").trim());
  }
  return result;
}
