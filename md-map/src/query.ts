// src/query.ts — 关系查询（纯函数，输入是已构建的索引）。

import type {
  MdCaller,
  MdDoc,
  MdImpactLayer,
  MdMapIndex,
  MdMapReport,
} from "./types.ts";

/** 按路径取文档。 */
export function getDoc(index: MdMapIndex, path: string): MdDoc | undefined {
  return index.docs.find((doc) => doc.path === path);
}

/**
 * 谁引用了该文档（或该锚点）。
 * `anchor` 给出时只统计指向该锚点的入边；`path` 可用相对 root 的路径或其后缀（如 `docs/x.md`）。
 */
export function callers(
  index: MdMapIndex,
  path: string,
  options: { anchor?: string } = {},
): MdCaller[] {
  const target = resolveDocRef(index, path);
  if (target === undefined) return [];
  const out: MdCaller[] = [];
  for (const doc of index.docs) {
    for (const edge of doc.edges) {
      if (edge.to !== target) continue;
      if (options.anchor !== undefined && edge.anchor !== options.anchor)
        continue;
      out.push({
        from: doc.path,
        line: edge.line,
        kind: edge.kind,
        ...(edge.anchor === undefined ? {} : { anchor: edge.anchor }),
        ...(edge.text === undefined ? {} : { text: edge.text }),
      });
    }
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
}

/** 把用户给的文档引用解析为索引内的确切路径（支持后缀匹配与锚点剥离）。 */
export function resolveDocRef(
  index: MdMapIndex,
  reference: string,
): string | undefined {
  const cleaned = reference.replace(/^\.\//, "").replace(/#.*$/, "");
  const exact = index.docs.find((doc) => doc.path === cleaned);
  if (exact !== undefined) return exact.path;
  const suffix = index.docs.filter((doc) => doc.path.endsWith(`/${cleaned}`));
  if (suffix.length === 1) return suffix[0]?.path;
  const byName = index.docs.filter(
    (doc) => (doc.path.split("/").pop() ?? "") === cleaned,
  );
  return byName.length === 1 ? byName[0]?.path : undefined;
}

/** 反向引用闭包：谁引用了该文档、再谁引用了那些文档……按层返回（不含起点）。 */
export function impact(
  index: MdMapIndex,
  path: string,
  options: { depth?: number } = {},
): MdImpactLayer[] {
  const start = resolveDocRef(index, path);
  if (start === undefined) return [];
  const depth = Math.max(1, options.depth ?? 2);
  const seen = new Set<string>([start]);
  const layers: MdImpactLayer[] = [];
  let frontier = [start];
  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next = new Set<string>();
    for (const doc of frontier) {
      for (const caller of callers(index, doc)) {
        if (seen.has(caller.from)) continue;
        seen.add(caller.from);
        next.add(caller.from);
      }
    }
    if (next.size === 0) break;
    layers.push({ depth: level, docs: [...next].sort() });
    frontier = [...next];
  }
  return layers;
}

/** 零入边文档（自引用不计；入口文档单独标出）。 */
export function orphans(
  index: MdMapIndex,
  options: { includeEntry?: boolean } = {},
): string[] {
  return index.docs
    .filter((doc) => doc.backlinks === 0)
    .filter((doc) => options.includeEntry === true || doc.entry !== true)
    .map((doc) => doc.path);
}

/** 被引最多的文档。 */
export function topBacklinks(
  index: MdMapIndex,
  limit = 10,
): Array<{ path: string; backlinks: number }> {
  return index.docs
    .filter((doc) => doc.backlinks > 0)
    .map((doc) => ({ path: doc.path, backlinks: doc.backlinks }))
    .sort((a, b) => b.backlinks - a.backlinks || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/** 汇总报告。 */
export function report(index: MdMapIndex): MdMapReport {
  return {
    root: index.root,
    docs: index.docs.length,
    anchors: index.docs.reduce((sum, doc) => sum + doc.anchors.length, 0),
    edges: index.edges,
    externalEdges: index.externalEdges,
    fileEdges: index.fileEdges,
    refEdges: index.refEdges,
    broken: index.broken,
    orphans: orphans(index),
    topBacklinks: topBacklinks(index),
    elapsedMs: index.elapsedMs,
    truncated: index.truncated,
  };
}

/** 就绪摘要（未索引时由工具面返回 `{ready:false}`）。 */
export function summary(index: MdMapIndex): {
  ready: true;
  root: string;
  docs: number;
  anchors: number;
  edges: number;
  broken: number;
  truncated: boolean;
  builtAt: string;
  elapsedMs: number;
} {
  return {
    ready: true,
    root: index.root,
    docs: index.docs.length,
    anchors: index.docs.reduce((sum, doc) => sum + doc.anchors.length, 0),
    edges: index.edges,
    broken: index.broken.length,
    truncated: index.truncated,
    builtAt: index.builtAt,
    elapsedMs: index.elapsedMs,
  };
}
