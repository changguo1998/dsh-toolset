// src/indexer.ts — 项目级索引：发现 `.md` → 逐文件复用 md-logic 解析 → 分类引用边 → 回填入边与断链。
//
// 只读、无副作用（不改任何文件）；每次 buildIndex 全量扫描（不做增量 / 文件监视）。

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { parseMarkdownDocument } from "@dsh-toolset/md-logic";

import {
  buildAnchors,
  candidateDocPaths,
  fenceLines,
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
  return (
    /^(readme|index)\b/i.test(name) || !path.includes("/")
  );
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

  const docs: MdDoc[] = [];
  const broken: MdBrockenLink[] = [];
  const anchorsByPath = new Map<string, Set<string>>();

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
      edges.push(
        await classify({
          from: path,
          target: link.href,
          line: link.line,
          ...(link.text === "" ? {} : { text: link.text }),
        }),
      );
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
  }): Promise<MdEdge> {
    const { from, target, line, text, anchor } = input;
    const isWiki = input.wiki === true;
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
    const resolved =
      pathPart === "" ? from : resolveDocPath(from, pathPart);
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
    broken,
  };
}

/** 便于测试：把相对路径统一成 POSIX（Windows 分隔符兼容）。 */
export function toPosix(path: string): string {
  return path.split(sep).join("/");
}
