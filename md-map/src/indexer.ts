// src/indexer.ts — 项目级索引：发现 `.md` → 逐文件复用 md-logic 解析 → 分类引用边 → 回填入边与断链。
//
// 只读、无副作用（不改任何文件）；每次 buildIndex 全量扫描（不做增量 / 文件监视）。

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

import { parseMarkdownDocument } from "@dsh-toolset/md-logic";

import {
  buildAnchors,
  candidateDocPaths,
  dirOf,
  fenceLines,
  scanInlineRefs,
  isExternal,
  resolveDocPath,
  scanWikiLinks,
  splitHref,
  wikiCandidates,
} from "./links.ts";
import type {
  MdBrockenLink,
  MdDoc,
  MdEdge,
  MdMapIndex,
  MdMapOptions,
} from "./types.ts";

/** 默认文件数上限。 */
export const DEFAULT_MAX_FILES = 2000;

/** 默认跳过的目录名（相对 root 的任一层）。 */
export const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  ".pi-glla",
  "tmp",
];

/** 判断是否 Markdown 文件（大小写不敏感）。 */
function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

/** 发现 root 下所有 `.md`（POSIX 相对路径、字典序）；按 `maxFiles` 截断。 */
export async function findMarkdownFiles(
  root: string,
  excludes: readonly string[],
  maxFiles: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (excludes.includes(entry.name)) continue;
        await walk(join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile() || !isMarkdown(entry.name)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(rel);
    }
  };
  await walk(root, "");
  return { files, truncated };
}

/** 入口文档启发式（`README*` / `index*` / 根目录文档）。 */
function isEntryDoc(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return /^(readme|index)\b/i.test(name) || !path.includes("/");
}

/** 构建项目级索引。 */
export async function buildIndex(
  options: MdMapOptions = {},
): Promise<MdMapIndex> {
  const started = Date.now();
  const root = resolve(options.root ?? process.cwd());
  const excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const { files, truncated } = await findMarkdownFiles(
    root,
    excludes,
    maxFiles,
  );
  const indexed = new Set(files);

  /** 磁盘存在性缓存（用于 file / broken 判定）。 */
  const existsCache = new Map<string, boolean>();
  const existsOnDisk = async (relPath: string): Promise<boolean> => {
    const cached = existsCache.get(relPath);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
      await stat(join(root, relPath));
      ok = true;
    } catch {
      ok = false;
    }
    existsCache.set(relPath, ok);
    return ok;
  };

  /** 磁盘上的**目录**判定（ref 的目录形态兜底用；与 existsOnDisk 同款缓存与 root 基准）。 */
  const dirCache = new Map<string, boolean>();
  const isDirectoryOnDisk = async (relPath: string): Promise<boolean> => {
    const cached = dirCache.get(relPath);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
      ok = (await stat(join(root, relPath))).isDirectory();
    } catch {
      ok = false;
    }
    dirCache.set(relPath, ok);
    return ok;
  };

  const docs: MdDoc[] = [];
  const broken: MdBrockenLink[] = [];
  const anchorsByPath = new Map<string, Set<string>>();
  /** 未解析的行内代码路径 token（0 命中的 (行,token) 条数；仅计数，不计断链——漂移探针） */
  let refUnresolved = 0;
  /** 上者中以 `.md` 结尾的子集（文档改名 / 写错路径的直接探针） */
  let refUnresolvedMd = 0;

  // 第一遍：逐文件解析（结构来自 md-logic），收集锚点与候选边
  for (const path of files) {
    let text = "";
    try {
      text = await readFile(join(root, path), "utf8");
    } catch {
      continue;
    }
    const parsed = parseMarkdownDocument(text);
    const anchors = buildAnchors(parsed.sections);
    anchorsByPath.set(path, new Set(anchors.map((a) => a.anchor)));

    const normalizedLines = text
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    // 代码行集合：md-logic 的顶层 code 块 ∪ 自带围栏状态机（覆盖列表 / 引用内嵌的围栏）
    const codeLines = fenceLines(normalizedLines);
    for (const block of parsed.blocks) {
      // 代码区：围栏 code 块 + frontmatter + HTML 块（`<pre>` / 注释里的语法都不该被当引用）
      if (
        block.kind !== "code" &&
        block.kind !== "frontmatter" &&
        block.kind !== "html"
      ) {
        continue;
      }
      for (let line = block.line; line <= block.endLine; line += 1) {
        codeLines.add(line);
      }
    }

    const edges: MdEdge[] = [];
    for (const link of parsed.links) {
      // `definition` 是引用式定义的**目标声明**、`image` 是资源引用：都不计为文档关系边
      if (link.kind !== "link") continue;
      const linkEdge = await classify({
        from: path,
        target: link.href,
        line: link.line,
        ...(link.text === "" ? {} : { text: link.text }),
      });
      if (linkEdge !== undefined) edges.push(linkEdge);
    }
    for (const ref of scanInlineRefs(normalizedLines, codeLines)) {
      const refEdge = await classify({
        from: path,
        target: ref.token,
        line: ref.line,
        ref: true,
      });
      if (refEdge === undefined) {
        // 0 命中：不产边、不计断链，只计数（文档改名 / 写错路径的漂移探针）
        refUnresolved += 1;
        if (/\.md$/i.test(ref.token)) refUnresolvedMd += 1;
        continue;
      }
      edges.push(refEdge);
    }
    for (const wiki of scanWikiLinks(normalizedLines, codeLines)) {
      const edge = await classify({
        from: path,
        target: wiki.target,
        line: wiki.line,
        ...(wiki.anchor === undefined ? {} : { anchor: wiki.anchor }),
        ...(wiki.text === undefined ? {} : { text: wiki.text }),
        wiki: true,
      });
      if (edge !== undefined) edges.push(edge);
    }
    edges.sort((a, b) => a.line - b.line);
    docs.push({
      path,
      lines: parsed.lines,
      anchors,
      edges,
      backlinks: 0,
      ...(isEntryDoc(path) ? { entry: true } : {}),
    });
  }

  // 锚点校验 + 断链登记 + 入边计数（第二遍：此时全部文档与锚点已知）
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  let edges = 0;
  let externalEdges = 0;
  let fileEdges = 0;
  let refEdges = 0;
  for (const doc of docs) {
    for (const edge of doc.edges) {
      if (edge.kind === "external") {
        externalEdges += 1;
        continue;
      }
      if (edge.kind === "file") {
        fileEdges += 1;
        continue;
      }
      if (edge.kind === "broken") continue;
      if (edge.kind === "ref") refEdges += 1;
      edges += 1;
      if (edge.anchor !== undefined && edge.to !== undefined) {
        const known = anchorsByPath.get(edge.to);
        edge.anchorOk = known?.has(edge.anchor) ?? false;
        if (!edge.anchorOk) {
          broken.push({
            from: doc.path,
            line: edge.line,
            target: edge.target,
            reason: "missing-anchor",
          });
        }
      }
      // 自引用（指向自己）不计入 backlinks，避免「自己引用自己 → 不是孤儿」的假阴性
      if (edge.to !== undefined && edge.to !== doc.path) {
        const target = byPath.get(edge.to);
        if (target !== undefined) target.backlinks += 1;
      }
    }
  }

  /** 把「原始目标」分类为一条出边；外部 / 文件 / 断链都返回边（图片与定义已在调用处过滤）。 */
  async function classify(input: {
    from: string;
    target: string;
    line: number;
    anchor?: string;
    text?: string;
    wiki?: boolean;
    /** 行内代码路径引用（BACKLOG #1）：只认唯一命中索引内文档的 token */
    ref?: boolean;
  }): Promise<MdEdge | undefined> {
    const { from, target, line, text, anchor } = input;
    const isWiki = input.wiki === true;
    if (input.ref === true) {
      // ① 拆锚点：`` `x.md#sec` `` 的 `#sec` 是锚点而非路径的一部分（原先整串当路径 → 永不命中）
      const { path: refPath, anchor: refAnchor } = splitHref(target);
      const raw = refPath;
      const hits: string[] = [];
      for (const candidate of wikiCandidates(from, raw)) {
        if (indexed.has(candidate) && !hits.includes(candidate))
          hits.push(candidate);
      }
      // ③ 跨模块裸名（`` `SPEC.md` ``）：候选序只覆盖 root / 源目录两处；索引里**唯一**同名文档兜底
      // （多个同名 → 不猜，保持未解析——歧义宁缺毋滥）
      if (hits.length === 0 && !raw.includes("/") && /\.md$/i.test(raw)) {
        const same = [...indexed].filter(
          (doc) => doc === raw || doc.endsWith(`/${raw}`),
        );
        if (same.length === 1 && same[0] !== undefined) hits.push(same[0]);
      }
      // 0 = 未命中（不产边、不计断链）；多个命中优先**源目录**形态（模块 README 指本模块 BACKLOG），
      // 否则取候选序首个（root 相对优先）——与 wiki 同串同解，避免「行内代码写法丢边」
      if (hits.length > 0) {
        const fromDir = dirOf(from);
        const own = hits.find(
          (hit) =>
            hit !== from && (fromDir === "" || hit.startsWith(`${fromDir}/`)),
        );
        return {
          kind: "ref",
          target,
          to: own ?? hits[0]!,
          line,
          ...(refAnchor === undefined ? {} : { anchor: refAnchor }),
        };
      }
      // ② 目录形态 token（`` `docs/archived` ``，尾斜杠已在扫描器剥掉）：索引内无 md 命中，
      // 但该路径在磁盘上是**目录** → 与文件引用分支同口径落 `file` 边（不再一律计入未解析）。
      // 判定用 `stat().isDirectory()`（名含点的目录如 `docs/v1.0` 也算），故 md 文件形态天然
      // 不在此兜底（不绕过 `exclude`）。
      // 出边目标必须是 **root 内规范化路径**：两个候选（root 相对 / 源目录相对）都过 `normalize`
      // 与包含性检查——中段越界（`docs/../../outside`）与仓库外绝对路径一律丢弃；`../docs`
      // 这类「源目录相对但落在 root 内」的形态靠第二个候选正常命中。
      // 空路径（`?a/b#c` 这类 query-only href 拆出 `path === ""`）没有目标可兜底 → 直接不产边：
      // 否则 `resolveDocPath(from, "")` 返回**源目录本身**，会产出指向自身目录的假 `file` 边
      if (raw === "") return undefined;
      const dirCandidates: string[] = [];
      const addCandidate = (value: string | null): void => {
        if (value === null) return;
        const path = normalize(value).replace(/\/+$/, "");
        if (
          path === "" ||
          path === "." ||
          path.startsWith("..") ||
          isAbsolute(path)
        ) {
          return;
        }
        if (!dirCandidates.includes(path)) dirCandidates.push(path);
      };
      addCandidate(raw);
      addCandidate(resolveDocPath(from, raw));
      for (const candidate of dirCandidates) {
        if (await isDirectoryOnDisk(candidate)) {
          return { kind: "file", target, to: candidate, line };
        }
      }
      return undefined;
    }
    if (isWiki) {
      for (const candidate of wikiCandidates(from, target)) {
        if (!indexed.has(candidate)) continue;
        return {
          kind: "wiki",
          target,
          to: candidate,
          ...(anchor === undefined ? {} : { anchor }),
          ...(text === undefined ? {} : { text }),
          line,
        };
      }
      // 未命中索引：可能是已存在的非 md 文件 / 目录（与普通链接同口径）
      for (const candidate of wikiCandidates(from, target)) {
        if (!(await existsOnDisk(candidate))) continue;
        return {
          kind: "file",
          target,
          to: candidate,
          ...(text === undefined ? {} : { text }),
          line,
        };
      }
      broken.push({ from, line, target, reason: "missing-file" });
      return {
        kind: "broken",
        target,
        ...(anchor === undefined ? {} : { anchor }),
        ...(text === undefined ? {} : { text }),
        line,
      };
    }
    if (isExternal(target)) {
      return {
        kind: "external",
        target,
        ...(text === undefined ? {} : { text }),
        line,
      };
    }
    const { path: pathPart, anchor: hrefAnchor } = splitHref(target);
    const resolved = pathPart === "" ? from : resolveDocPath(from, pathPart);
    if (resolved === null) {
      broken.push({ from, line, target, reason: "outside-root" });
      return { kind: "broken", target, line };
    }
    const targetAnchor = anchor ?? hrefAnchor;
    if (indexed.has(resolved)) {
      return {
        kind: "internal",
        target,
        to: resolved,
        ...(targetAnchor === undefined ? {} : { anchor: targetAnchor }),
        ...(text === undefined ? {} : { text }),
        line,
      };
    }
    const candidates = candidateDocPaths(resolved, (candidate) =>
      indexed.has(candidate),
    );
    const matched = candidates[0];
    if (matched !== undefined) {
      return {
        kind: "internal",
        target,
        to: matched,
        ...(targetAnchor === undefined ? {} : { anchor: targetAnchor }),
        ...(text === undefined ? {} : { text }),
        line,
      };
    }
    if (await existsOnDisk(resolved)) {
      return {
        kind: "file",
        target,
        to: resolved,
        ...(text === undefined ? {} : { text }),
        line,
      };
    }
    broken.push({ from, line, target, reason: "missing-file" });
    return {
      kind: "broken",
      target,
      ...(text === undefined ? {} : { text }),
      line,
    };
  }

  broken.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root,
    builtAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    truncated,
    docs,
    edges,
    externalEdges,
    fileEdges,
    refEdges,
    refUnresolved,
    refUnresolvedMd,
    broken,
  };
}

/** 便于测试：把相对路径统一成 POSIX（Windows 分隔符兼容）。 */
export function toPosix(path: string): string {
  return path.split(sep).join("/");
}
