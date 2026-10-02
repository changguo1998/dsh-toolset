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

/** 去掉行内代码片段（`` `[[x]]` `` 这类示例不该被当成 wiki 链接）。 */
export function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, "");
}

/**
 * 围栏代码块的行集合（1 基）。
 * 注意：`md-logic` 的 `blocks` 只报**顶层**块，列表 / 引用内嵌的围栏不在其中，
 * 故这里自带一个 CommonMark 口径的围栏状态机（`^ {0,3}` 缩进、闭合串不短于开启串）。
 */
export function fenceLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  let open: { char: string; len: number } | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const matched = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    out.add(i + 1);
    if (matched === null) {
      if (open === undefined) out.delete(i + 1);
      continue;
    }
    const marker = matched[1] ?? "";
    const info = (matched[2] ?? "").trim();
    if (open === undefined) {
      open = { char: marker[0] ?? "`", len: marker.length };
      continue;
    }
    if ((marker[0] ?? "") === open.char && marker.length >= open.len && info === "") {
      open = undefined;
    }
  }
  return out;
}

/** 按行扫 wiki 链接；`skipLines`（1 基）用于跳过代码块内的行。 */
export function scanWikiLinks(
  lines: string[],
  skipLines: ReadonlySet<number> = new Set(),
): WikiLink[] {
  const out: WikiLink[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    if (skipLines.has(lineNo)) continue;
    const line = stripInlineCode(lines[i] ?? "");
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
    ...(anchor === undefined || anchor === "" ? {} : { anchor: safeDecode(anchor) }),
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
    candidates.push(`${resolved}.md`, `${resolved}/README.md`, `${resolved}/index.md`);
  }
  return candidates.filter(isIndexed);
}

/**
 * wiki 链接目标候选：先按 **root 相对**，再按**源文件目录相对**；
 * 无扩展名时额外尝试目录形式（`<x>/README.md` / `<x>/index.md`），与普通链接同口径。
 */
export function wikiCandidates(
  fromPath: string,
  target: string,
): string[] {
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
