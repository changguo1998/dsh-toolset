// src/query.ts — 结构查询（纯函数，零宿主依赖；供工具面与其它插件消费）。

import type {
  MdBlock,
  MdBlockKind,
  MdLink,
  MdLinkKind,
  MarkdownDocument,
  SectionNode,
} from "./types.ts";

/** 扁平化后的节（带层级深度与标题路径，便于定位与展示）。 */
export interface FlatSection {
  level: number;
  /** 层级深度（1 = 顶层节）。 */
  depth: number;
  title: string;
  /** 标题路径，如 `标题一 › 小节 1.1`。 */
  path: string;
  line: number;
  endLine: number;
}

/** 按文档顺序扁平化节树（前序）。 */
export function flattenSections(sections: SectionNode[]): FlatSection[] {
  const out: FlatSection[] = [];
  const walk = (nodes: SectionNode[], depth: number, prefix: string): void => {
    for (const node of nodes) {
      const path = prefix === "" ? node.title : `${prefix} › ${node.title}`;
      out.push({
        level: node.level,
        depth,
        title: node.title,
        path,
        line: node.line,
        endLine: node.endLine,
      });
      walk(node.children, depth + 1, path);
    }
  };
  walk(sections, 1, "");
  return out;
}

/** 节筛选条件。 */
export interface SectionQuery {
  /** 只看这些层级（如 `[1, 2]`）。 */
  levels?: number[];
  /** 标题包含该子串（大小写不敏感）。 */
  pattern?: string;
  /** 只保留包含该行的节。 */
  line?: number;
  /** 结果上限（默认不限）。 */
  limit?: number;
}

/** 查询节。 */
export function findSections(
  doc: MarkdownDocument,
  query: SectionQuery = {},
): FlatSection[] {
  const needle = query.pattern?.toLowerCase();
  let rows = flattenSections(doc.sections);
  if (query.levels !== undefined && query.levels.length > 0) {
    const levels = new Set(query.levels);
    rows = rows.filter((row) => levels.has(row.level));
  }
  if (needle !== undefined && needle !== "") {
    rows = rows.filter(
      (row) =>
        row.title.toLowerCase().includes(needle) ||
        row.path.toLowerCase().includes(needle),
    );
  }
  if (query.line !== undefined) {
    rows = rows.filter(
      (row) => row.line <= query.line! && query.line! <= row.endLine,
    );
  }
  return query.limit === undefined ? rows : rows.slice(0, query.limit);
}

/** 包含该行的最深节（1 基行号）。 */
export function sectionAt(
  doc: MarkdownDocument,
  line: number,
): FlatSection | undefined {
  const rows = flattenSections(doc.sections).filter(
    (row) => row.line <= line && line <= row.endLine,
  );
  return rows.reduce<FlatSection | undefined>(
    (best, row) => (best === undefined || row.level >= best.level ? row : best),
    undefined,
  );
}

/** 块筛选条件。 */
export interface BlockQuery {
  kind?: MdBlockKind[];
  /** 只保留归属该标题行（1 基）的节内块。 */
  section?: number;
  /** 只保留落在 `[from, to]`（1 基，含）内的块。 */
  from?: number;
  to?: number;
  /** 只保留覆盖该行的块。 */
  line?: number;
  limit?: number;
}

/** 查询块。 */
export function queryBlocks(
  doc: MarkdownDocument,
  query: BlockQuery = {},
): MdBlock[] {
  let rows = doc.blocks;
  if (query.kind !== undefined && query.kind.length > 0) {
    const kinds = new Set(query.kind);
    rows = rows.filter((block) => kinds.has(block.kind));
  }
  if (query.section !== undefined) {
    rows = rows.filter((block) => block.section === query.section);
  }
  if (query.from !== undefined) {
    rows = rows.filter((block) => block.endLine >= query.from!);
  }
  if (query.to !== undefined) {
    rows = rows.filter((block) => block.line <= query.to!);
  }
  if (query.line !== undefined) {
    rows = rows.filter(
      (block) => block.line <= query.line! && query.line! <= block.endLine,
    );
  }
  return query.limit === undefined ? rows : rows.slice(0, query.limit);
}

/** 链接筛选条件。 */
export interface LinkQuery {
  kind?: MdLinkKind[];
  /** 匹配 href / 文本 / title 的子串（大小写不敏感）。 */
  pattern?: string;
  limit?: number;
}

/** 查询链接、图片与引用式定义。 */
export function listLinks(
  doc: MarkdownDocument,
  query: LinkQuery = {},
): MdLink[] {
  let rows = doc.links;
  if (query.kind !== undefined && query.kind.length > 0) {
    const kinds = new Set(query.kind);
    rows = rows.filter((link) => kinds.has(link.kind));
  }
  const needle = query.pattern?.toLowerCase();
  if (needle !== undefined && needle !== "") {
    rows = rows.filter((link) =>
      [link.href, link.text, link.title ?? ""].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }
  return query.limit === undefined ? rows : rows.slice(0, query.limit);
}
