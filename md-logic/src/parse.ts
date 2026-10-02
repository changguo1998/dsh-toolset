// src/parse.ts — Markdown 逻辑结构解析（唯一解析入口）。
//
// 解析器：`marked` 实例（唯一运行时依赖，零传递依赖）。做法与理由（见 README / 追踪文档）：
// - marked 的块级 token 按文档顺序给出 `raw`，且 **`raw` 拼接 === 输入文本**——这里的输入是
//   **剥 BOM、CRLF/CR → LF 归一化之后**的文本（marked 内部即按 LF 处理；传原文含 CRLF 会错位），
//   测试对该不变量有断言。故用「字符偏移游标 + 偏移 → 行号表」即得精确行范围。
// - `frontmatter` marked 不认（`---` 会被当成 hr + setext 标题），故先自行识别，再把该区间**置空
//   （保留行数）**后交给 marked，保证后续行号不漂移。
// - 节范围口径与 `fs-digest` 的 `scanMarkdown()` 对齐：节 = 标题行 → 下一个「层级 ≤ 本节」的标题前
//   一行（末节到文件末非空行），尾部空行不计，父子为包含关系。

import { Marked } from "marked";

import type {
  FrontmatterInfo,
  MdBlock,
  MdLink,
  MarkdownDocument,
  ParseOptions,
  SectionNode,
} from "./types.ts";

/** 解析器 token 的最小结构面（只声明本包读取的字段，避免耦合 marked 的类型演进）。 */
interface MdToken {
  type?: string;
  raw?: string;
  text?: string;
  depth?: number;
  lang?: string;
  ordered?: boolean;
  items?: MdToken[];
  /** 表格表头单元格；注意 marked 的列表项也用 `header` 存布尔标记，故必须数组守卫。 */
  header?: MdToken[] | boolean;
  rows?: MdToken[][] | boolean;
  tokens?: MdToken[];
  href?: string;
  title?: string | null;
  tag?: string;
}

/** 解析器实例（gfm 显式开启；不读全局 defaults——同进程其它消费者调 `marked.use(...)` 会改全局）。 */
const md = new Marked({ gfm: true });

const FRONTMATTER_DEFAULT_MAX_LINES = 40;
const FM_KEY_RE = /^([A-Za-z0-9_.-]+)\s*:/;
const FM_COMMENT_RE = /^\s*#/;

/** 识别文件首部 frontmatter（仅首行 `---` + 有界配对 + 内部只含键 / 注释 / 空行）。 */
export function detectFrontmatter(
  lines: string[],
  maxLines: number = FRONTMATTER_DEFAULT_MAX_LINES,
): FrontmatterInfo | undefined {
  if ((lines[0] ?? "").trim() !== "---") return undefined;
  const limit = Math.min(lines.length, maxLines + 1);
  let end = -1;
  for (let i = 1; i < limit; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end <= 0) return undefined;
  const inner = lines.slice(1, end);
  if (inner.length === 0) return undefined;
  const isYaml = inner.every((line) => {
    const value = line ?? "";
    return (
      value.trim() === "" || FM_KEY_RE.test(value) || FM_COMMENT_RE.test(value)
    );
  });
  if (!isYaml) return undefined;
  const keys: string[] = [];
  for (const line of inner) {
    const matched = (line ?? "").match(FM_KEY_RE);
    const key = matched?.[1];
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  }
  return { line: 1, endLine: end + 1, keys };
}

/** 把前 `count` 行置空（保持行数，供 marked 跳过 frontmatter 区间）。 */
function blankFirstLines(text: string, count: number): string {
  const lines = text.split("\n");
  for (let i = 0; i < count && i < lines.length; i += 1) lines[i] = "";
  return lines.join("\n");
}

/** 数组守卫（marked 的 `header` / `rows` 在列表项上是布尔标记，不能直接迭代）。 */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** 列表条目总数与最大嵌套层数（`depth` 1 = 不嵌套）。 */
function listStats(
  token: MdToken,
  depth = 1,
): { items: number; depth: number } {
  let items = 0;
  let maxDepth = depth;
  for (const item of asArray<MdToken>(token.items)) {
    items += 1;
    for (const child of asArray<MdToken>(item.tokens)) {
      if (child.type === "list") {
        const nested = listStats(child, depth + 1);
        items += nested.items;
        maxDepth = Math.max(maxDepth, nested.depth);
      }
    }
  }
  return { items, depth: maxDepth };
}

/** 引用块嵌套层数。 */
function quoteDepth(token: MdToken, depth = 1): number {
  let maxDepth = depth;
  for (const child of asArray<MdToken>(token.tokens)) {
    if (child.type === "blockquote")
      maxDepth = Math.max(maxDepth, quoteDepth(child, depth + 1));
  }
  return maxDepth;
}

/** 递归收集块内联 token（段落 / 标题 / 列表项 / 表格单元格 / 引用内的行内内容）。 */
function collectInline(token: MdToken, out: MdToken[]): void {
  for (const child of asArray<MdToken>(token.tokens)) {
    if (child.type === "link" || child.type === "image") out.push(child);
    collectInline(child, out);
  }
  for (const item of asArray<MdToken>(token.items)) collectInline(item, out);
  for (const cell of asArray<MdToken>(token.header)) collectInline(cell, out);
  for (const row of asArray<MdToken[]>(token.rows)) {
    for (const cell of asArray<MdToken>(row)) collectInline(cell, out);
  }
}

/** 在块原文里按序定位内联 token 的起始偏移（同一链接重复出现时按出现顺序消歧）。 */
function locateInRaw(
  raw: string,
  needles: string[],
  from = 0,
): Array<number | undefined> {
  const offsets: Array<number | undefined> = [];
  let cursor = from;
  for (const needle of needles) {
    const at = needle === "" ? -1 : raw.indexOf(needle, cursor);
    if (at < 0) {
      const fallback = needle === "" ? -1 : raw.indexOf(needle);
      offsets.push(fallback < 0 ? undefined : fallback);
      continue;
    }
    offsets.push(at);
    cursor = at + needle.length;
  }
  return offsets;
}

/**
 * 解析 Markdown 文本为逻辑结构（节树 + 块 + 链接）。
 * 纯函数、无 IO；同一输入恒得同一结果。
 */
export function parseMarkdownDocument(
  text: string,
  options: ParseOptions = {},
): MarkdownDocument {
  // 归一化：剥 BOM、CRLF/CR → LF（marked 内部按 LF 处理 raw，不归一化会让偏移与行号错位）
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const sourceLines = source.split("\n");
  const totalLines = sourceLines.length;
  const frontmatter =
    options.frontmatter === false
      ? undefined
      : detectFrontmatter(
          sourceLines,
          options.frontmatterMaxLines ?? FRONTMATTER_DEFAULT_MAX_LINES,
        );
  const lexicalSource =
    frontmatter === undefined
      ? source
      : blankFirstLines(source, frontmatter.endLine);

  // 行首偏移表 + 二分：偏移 → 1 基行号（O(log n)；大文档下不做逐 token 线性扫前缀）
  const lineStarts: number[] = [0];
  for (let i = 0; i < lexicalSource.length; i += 1) {
    if (lexicalSource.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    const limit = Math.max(0, Math.min(offset, lexicalSource.length));
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((lineStarts[mid] ?? 0) <= limit) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const tokens = md.lexer(lexicalSource) as unknown as MdToken[];

  // 第一遍：标题（含 setext）→ 节树 + 行范围
  const headings: Array<{ level: number; title: string; line: number }> = [];
  const blocks: MdBlock[] = [];
  const links: MdLink[] = [];
  let offset = 0;
  for (const token of tokens) {
    const raw = token.raw ?? "";
    if (token.type === "heading") {
      headings.push({
        level: token.depth ?? 1,
        title: (token.text ?? "").trim(),
        line: lineOf(offset),
      });
    }
    offset += raw.length;
  }
  const lastContent = (() => {
    for (let i = sourceLines.length - 1; i >= 0; i -= 1) {
      if ((sourceLines[i] ?? "").trim() !== "") return i + 1;
    }
    return 0;
  })();

  const roots: SectionNode[] = [];
  const stack: Array<{ node: SectionNode; level: number }> = [];
  const flat: SectionNode[] = [];
  for (const heading of headings) {
    const node: SectionNode = {
      level: heading.level,
      title: heading.title,
      line: heading.line,
      endLine: heading.line,
      children: [],
    };
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined || top.level < heading.level) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.node;
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack.push({ node, level: heading.level });
    flat.push(node);
  }
  const extend = (node: SectionNode): number => {
    let end = lastContent;
    for (const heading of headings) {
      if (heading.line > node.line && heading.level <= node.level) {
        end = heading.line - 1;
        break;
      }
    }
    while (end > node.line && (sourceLines[end - 1] ?? "").trim() === "")
      end -= 1;
    let childEnd = node.line;
    for (const child of node.children)
      childEnd = Math.max(childEnd, extend(child));
    const finalEnd = Math.max(node.line, end, childEnd);
    node.endLine = finalEnd;
    return finalEnd;
  };
  for (const root of roots) extend(root);

  const sectionOf = (line: number): number | undefined => {
    let best: SectionNode | undefined;
    for (const node of flat) {
      if (node.line <= line && line <= node.endLine) {
        if (best === undefined || node.level >= best.level) best = node;
      }
    }
    return best?.line;
  };

  // 第二遍：块与链接（按字符偏移推进游标）
  if (frontmatter !== undefined) {
    blocks.push({
      kind: "frontmatter",
      line: frontmatter.line,
      endLine: frontmatter.endLine,
      count: frontmatter.keys.length,
    });
  }
  offset = 0;
  for (const token of tokens) {
    const raw = token.raw ?? "";
    const startLine = lineOf(offset);
    const endLine = lineOf(offset + Math.max(0, raw.length - 1));
    const section = sectionOf(startLine);
    const withSection = <T extends MdBlock>(block: T): T =>
      section === undefined ? block : { ...block, section };

    switch (token.type) {
      case "code": {
        const lang = (token.lang ?? "").trim();
        blocks.push(
          withSection({
            kind: "code",
            line: startLine,
            endLine,
            ...(lang === "" ? {} : { lang }),
          }),
        );
        break;
      }
      case "html":
        blocks.push(withSection({ kind: "html", line: startLine, endLine }));
        break;
      case "hr":
        blocks.push(withSection({ kind: "hr", line: startLine, endLine }));
        break;
      case "table": {
        blocks.push(
          withSection({
            kind: "table",
            line: startLine,
            endLine,
            count: asArray<MdToken[]>(token.rows).length,
            cols: asArray<MdToken>(token.header).length,
          }),
        );
        break;
      }
      case "list": {
        const stats = listStats(token);
        blocks.push(
          withSection({
            kind: "list",
            line: startLine,
            endLine,
            count: stats.items,
            depth: stats.depth,
          }),
        );
        break;
      }
      case "blockquote": {
        blocks.push(
          withSection({
            kind: "quote",
            line: startLine,
            endLine,
            count: endLine - startLine + 1,
            depth: quoteDepth(token),
          }),
        );
        break;
      }
      case "def": {
        links.push({
          kind: "definition",
          text: token.tag ?? "",
          href: token.href ?? "",
          ...(token.title == null || token.title === ""
            ? {}
            : { title: token.title }),
          line: startLine,
          ...(section === undefined ? {} : { section }),
        });
        break;
      }
      default:
        break;
    }

    // 行内链接 / 图片：在块原文里按出现顺序定位
    const inline: MdToken[] = [];
    collectInline(token, inline);
    const targets = inline.filter(
      (node) => node.type === "link" || node.type === "image",
    );
    if (targets.length > 0) {
      const offsets = locateInRaw(
        raw,
        targets.map((node) => node.raw ?? ""),
      );
      targets.forEach((node, index) => {
        const at = offsets[index];
        const line = at === undefined ? startLine : lineOf(offset + at);
        links.push({
          kind: node.type === "image" ? "image" : "link",
          text: (node.text ?? "").trim(),
          href: node.href ?? "",
          ...(node.title == null || node.title === ""
            ? {}
            : { title: node.title }),
          line,
          ...(sectionOf(line) === undefined
            ? {}
            : { section: sectionOf(line) }),
        });
      });
    }
    offset += raw.length;
  }

  links.sort((a, b) => a.line - b.line);

  return {
    lines: totalLines,
    ...(frontmatter === undefined ? {} : { frontmatter }),
    sections: roots,
    blocks,
    links,
  };
}
