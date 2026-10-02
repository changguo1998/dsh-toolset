// src/links.ts — 锚点 slug、wiki 链接补扫、链接目标解析（纯函数，文件系统访问由 indexer 注入）。
//
// 分工：单文件结构由 `@dsh-toolset/md-logic` 提供（标题树 + link/image/definition 三类链接）；
// 本模块补 md-logic 不产的两件事——**GitHub 风格锚点**与 **wiki 链接**，并把目标**分类**为
// internal / wiki / file / external / broken。

import { flattenSections, type SectionNode } from "@dsh-toolset/md-logic";

import type { MdAnchor } from "./types.ts";

/** POSIX 路径拼接（不引 node:path 以保持纯函数可测）；`escaped` 表示越过 root。 */
function joinPosix(
  dir: string,
  rel: string,
): { path: string; escaped: boolean } {
  const parts = dir === "" ? [] : dir.split("/");
  let escaped = false;
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) escaped = true;
      else parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return { path: parts.join("/"), escaped };
}

/** 取 POSIX 目录（不含文件名）。 */
export function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** GitHub 风格锚点 slug：小写 → 去标点（保留字母 / 数字 / 空白 / `-`）→ 空白转 `-`。 */
export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** 从标题树生成锚点表（同名重复按出现顺序加 `-1` / `-2` 后缀，与 GitHub 一致）。 */
export function buildAnchors(sections: SectionNode[]): MdAnchor[] {
  const seen = new Map<string, number>();
  return flattenSections(sections).map((row) => {
    const base = slugify(row.title);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      text: row.title,
      anchor: count === 0 ? base : `${base}-${count}`,
      level: row.level,
      line: row.line,
    };
  });
}

/** wiki 链接（`[[Target]]` / `[[Target|文本]]` / `[[Target#anchor]]`）。 */
export interface WikiLink {
  target: string;
  anchor?: string;
  text?: string;
  line: number;
}

const WIKI_RE = /\[\[([^\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

/** 去掉行内代码片段（`` `[[x]]` `` 这类示例不该被当成 wiki 链接）。**单行**语义。 */
export function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, "");
}

/** 在 `line` 的 `from` 之后找长度恰为 `len` 的反引号串；找到返回起点，没有返回 -1。 */
function findBacktickRun(line: string, from: number, len: number): number {
  for (let i = from; i < line.length; i += 1) {
    if (line[i] !== "`") continue;
    let run = 0;
    while (line[i + run] === "`") run += 1;
    if (run === len) return i;
    i += run - 1;
  }
  return -1;
}

/**
 * 跨行 code span 剥离（BACKLOG #2②）：返回「去掉行内代码片段」的逐行文本。
 * 反引号开启串在本行找不到等长闭合串时，余下行视为代码，直到后续行出现等长闭合串
 * （CommonMark 的 code span 闭合要求**等长**，与围栏的「不短于」不同）。
 */
export function stripInlineCodeAcross(lines: readonly string[]): string[] {
  const out: string[] = [];
  let para: { idx: number; line: string }[] = [];
  const flush = (): void => {
    if (para.length === 0) return;
    const base = para[0]?.idx ?? 0;
    const result = stripWithinParagraph(para.map((item) => item.line));
    if (result.open !== 0) {
      // 段内无等长闭合串 → 整段按**字面量**（CommonMark：闭合串只在同一段落内找）
      for (const item of para) out[item.idx] = item.line;
    } else {
      para.forEach((item, k) => {
        out[item.idx] = result.texts[k] ?? item.line;
      });
    }
    void base;
    para = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      flush();
      out[i] = "";
      continue;
    }
    para.push({ idx: i, line });
  }
  flush();
  return out;
}

/** 段落内剥离行内代码：返回逐行文本与「段尾仍未闭合的反引号长度」。 */
function stripWithinParagraph(lines: readonly string[]): {
  texts: string[];
  open: number;
} {
  const texts: string[] = [];
  let open = 0;
  for (const line of lines) {
    let text = "";
    let i = 0;
    while (i < line.length) {
      if (open === 0) {
        if (line[i] !== "`") {
          text += line[i];
          i += 1;
          continue;
        }
        const run = /^`+/.exec(line.slice(i))?.[0].length ?? 1;
        const close = findBacktickRun(line, i + run, run);
        if (close < 0) {
          open = run;
          i = line.length;
          continue;
        }
        i = close + run;
        continue;
      }
      const close = findBacktickRun(line, i, open);
      if (close < 0) {
        i = line.length;
        continue;
      }
      i = close + open;
      open = 0;
    }
    texts.push(text);
  }
  return { texts, open };
}

/** 行内代码片段内容（跨行 span 逐行切段）；用于路径引用 token 提取。 */
export function inlineCodeSpans(
  lines: readonly string[],
): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let open = 0;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    let i = 0;
    while (i < line.length) {
      if (open === 0) {
        if (line[i] !== "`") {
          i += 1;
          continue;
        }
        const run = /^`+/.exec(line.slice(i))?.[0].length ?? 1;
        const close = findBacktickRun(line, i + run, run);
        if (close < 0) {
          open = run;
          i = line.length;
          continue;
        }
        out.push({ text: line.slice(i + run, close), line: idx + 1 });
        i = close + run;
        continue;
      }
      const close = findBacktickRun(line, i, open);
      if (close < 0) {
        i = line.length;
        continue;
      }
      i = close + open;
      open = 0;
    }
  }
  return out;
}

/** 路径形 token：无空白、非站外 / flag / 锚点。 */
const REF_TOKEN_RE = /^(?!https?:\/\/)(?!-)(?!#)[^\s`]+$/;

/**
 * 行内代码里的**路径引用** token（BACKLOG #1，`kind:"ref"`）：
 * 只取代码片段内容，要求「含 `/` 或 `.md` 结尾」；同 (行, token) 去重。
 * 未命中索引的 token 由调用方丢弃（**不计断链**——示例路径不该变噪声）。
 */
export function scanInlineRefs(
  lines: readonly string[],
  skipLines: ReadonlySet<number> = new Set(),
): { token: string; line: number }[] {
  const masked = lines.map((line, idx) => (skipLines.has(idx + 1) ? "" : line));
  const seen = new Set<string>();
  const out: { token: string; line: number }[] = [];
  for (const span of inlineCodeSpans(masked)) {
    // 去首尾 `/`（`md-logic/` 这类目录写法；前导斜杠的 root 语义交给解析层）
    const token = span.text.trim().replace(/^\/+|\/+$/g, "");
    if (token === "" || !REF_TOKEN_RE.test(token)) continue;
    if (!token.includes("/") && !/\.md$/i.test(token)) continue;
    const key = `${span.line}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ token, line: span.line });
  }
  return out;
}

/**
 * 围栏代码块的行集合（1 基）。
 * 注意：`md-logic` 的 `blocks` 只报**顶层**块，列表 / 引用内嵌的围栏不在其中，
 * 故这里自带一个 CommonMark 口径的围栏状态机（`^ {0,3}` 缩进、闭合串不短于开启串）。
 */
export function fenceLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  /** 容器内容缩进栈（列表项 / 引用）；围栏缩进相对容器算（BACKLOG #2①） */
  const containers: number[] = [];
  let open: { char: string; len: number } | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const blank = line.trim() === "";
    const indent = line.length - line.replace(/^[ \t]*/, "").length;
    if (open === undefined && !blank) {
      // 容器栈仅在围栏外、非空行更新（空行不结束列表）
      while (
        containers.length > 0 &&
        indent < (containers[containers.length - 1] ?? 0)
      ) {
        containers.pop();
      }
      // 剥离**容器前缀**（`>` + 至多一空格；列表标记 + 1..4 空格填充）后再看内容
      const quote = /^(\s*)>\s?/.exec(line);
      const afterQuote = quote === null ? line : line.slice(quote[0].length);
      const quoteIndent = quote === null ? indent : indent + 2;
      if (quote !== null) containers.push(quoteIndent);
      const list = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/.exec(afterQuote);
      if (list !== null) {
        const spaces = (list[3] ?? "").length;
        const pad = spaces <= 4 ? spaces : 1; // ≥5 空格：按 1 计，其余是内容缩进
        containers.push(
          quoteIndent + (list[1] ?? "").length + (list[2] ?? "").length + pad,
        );
      }
    }
    const base =
      containers.length > 0 ? (containers[containers.length - 1] ?? 0) : 0;
    const content = stripContainerPrefix(line);
    const matched = content.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    const inZone = matched !== null && contentIndent(line) <= base + 3;
    if (open === undefined) {
      if (!inZone) continue;
      const marker = matched?.[2] ?? "";
      open = { char: marker[0] ?? "`", len: marker.length };
      out.add(i + 1);
      continue;
    }
    out.add(i + 1);
    if (!inZone) continue;
    const marker = matched?.[2] ?? "";
    const info = (matched?.[3] ?? "").trim();
    if (
      (marker[0] ?? "") === open.char &&
      marker.length >= open.len &&
      info === ""
    ) {
      open = undefined;
    }
  }
  return out;
}

/** 剥掉容器前缀（引用标记 + 列表标记及其填充），返回剩余内容。 */
function stripContainerPrefix(line: string): string {
  let rest = line;
  for (;;) {
    const quote = /^\s*>\s?/.exec(rest);
    if (quote !== null) {
      rest = rest.slice(quote[0].length);
      continue;
    }
    const list = /^(\s*)(?:[-*+]|\d{1,9}[.)])(\s+)/.exec(rest);
    if (list === null) return rest;
    const spaces = (list[2] ?? "").length;
    const pad = spaces <= 4 ? spaces : 1;
    rest = rest.slice(
      (list[1] ?? "").length +
        (list[0].length - (list[1] ?? "").length - (list[2] ?? "").length) +
        pad,
    );
  }
}

/** 内容缩进：容器前缀宽度 + 前缀后剩余缩进。 */
function contentIndent(line: string): number {
  const rest = stripContainerPrefix(line);
  return (
    line.length -
    rest.length +
    (rest.length - rest.replace(/^[ \t]*/, "").length)
  );
}

/** 按行扫 wiki 链接；`skipLines`（1 基）用于跳过代码块内的行。 */
export function scanWikiLinks(
  lines: string[],
  skipLines: ReadonlySet<number> = new Set(),
): WikiLink[] {
  const out: WikiLink[] = [];
  // 围栏行先掩码（避免其反引号污染跨行 code span 状态），再按跨行 code span 剥离（#2②）
  const stripped = stripInlineCodeAcross(
    lines.map((line, idx) => (skipLines.has(idx + 1) ? "" : line)),
  );
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    if (skipLines.has(lineNo)) continue;
    const line = stripped[i] ?? "";
    if (!line.includes("[[")) continue;
    WIKI_RE.lastIndex = 0;
    for (const match of line.matchAll(WIKI_RE)) {
      const target = (match[1] ?? "").trim();
      if (target === "") continue;
      const anchor = match[2]?.trim();
      const text = match[3]?.trim();
      out.push({
        target,
        ...(anchor === undefined || anchor === "" ? {} : { anchor }),
        ...(text === undefined || text === "" ? {} : { text }),
        line: lineNo,
      });
    }
  }
  return out;
}

/** root 相对目标（`/docs/x.md`）：按仓库根解析而不是相对源文件。 */
export function isRootRelative(pathPart: string): boolean {
  return pathPart.startsWith("/");
}

/** 站外目标（`http(s)` / `mailto:` / `tel:` / 协议相对 `//`）。 */
export function isExternal(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href.trim());
}

/** 拆分 href 为路径部分与锚点部分（去掉 query）。 */
export function splitHref(href: string): { path: string; anchor?: string } {
  const raw = href.trim();
  const hashAt = raw.indexOf("#");
  const beforeHash = hashAt < 0 ? raw : raw.slice(0, hashAt);
  const anchor = hashAt < 0 ? undefined : raw.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  return {
    path: safeDecode(path),
    ...(anchor === undefined || anchor === ""
      ? {}
      : { anchor: safeDecode(anchor) }),
  };
}

/** decodeURIComponent 的容错包装（畸形转义原样保留）。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 把链接路径解析为「相对 root 的 POSIX 路径」；逃出 root 时返回 null。 */
export function resolveDocPath(
  fromPath: string,
  pathPart: string,
): string | null {
  // 以 `/` 开头是「仓库根相对」的常见写法（GitHub / VitePress 都支持）：按 root 解析；
  // 真正的绝对路径（仓库外）由调用方在磁盘判定失败时归为 outside-root。
  if (isRootRelative(pathPart)) return pathPart.replace(/^\/+/, "");
  const resolved = joinPosix(dirOf(fromPath), pathPart);
  return resolved.escaped ? null : resolved.path;
}

/** 无扩展名的文档链接尝试：`docs/x` → `docs/x.md` / `docs/x/README.md`（按序取第一个命中的）。 */
export function candidateDocPaths(
  resolved: string,
  isIndexed: (path: string) => boolean,
): string[] {
  const candidates = [resolved];
  if (!/\.[A-Za-z0-9]+$/.test(resolved)) {
    candidates.push(
      `${resolved}.md`,
      `${resolved}/README.md`,
      `${resolved}/index.md`,
    );
  }
  return candidates.filter(isIndexed);
}

/**
 * wiki 链接目标候选：先按 **root 相对**，再按**源文件目录相对**；
 * 无扩展名时额外尝试目录形式（`<x>/README.md` / `<x>/index.md`），与普通链接同口径。
 */
export function wikiCandidates(fromPath: string, target: string): string[] {
  const raw = target.replace(/^\/+/, "");
  const hasExt = /\.[A-Za-z0-9]+$/.test(raw);
  const out: string[] = [];
  const push = (path: string): void => {
    if (path !== "" && !out.includes(path)) out.push(path);
  };
  const pushForms = (base: string): void => {
    if (hasExt) {
      push(base);
      return;
    }
    push(`${base}.md`);
    push(`${base}/README.md`);
    push(`${base}/index.md`);
  };
  pushForms(raw);
  const relative = resolveDocPath(fromPath, raw);
  if (relative !== null && relative !== raw) pushForms(relative);
  return out;
}
