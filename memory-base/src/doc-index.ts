/**
 * 文档索引扫描器（设计 §7.2 / §12 #12，决策 D45-D47）。
 *
 * 扫描 = glob 展开 → `md-logic` 切节（复用 CommonMark 节树 + 行范围）→ 差异写入 +
 * 三态更新（`present` / `stale` / `missing`，只改 status 列，不自动改写摘要、不自动删行）。
 * 正文不入库；FTS 只挂章节标题与摘要行（建表见 `schema.ts` `ensureDocIndex`）。
 *
 * 判变（D47）：调用方可传进程内 `cache`（doc_ref → mtime+size+hash）做 mtime/size 粗筛，
 * 未传则每次全量重算 hash（正确性不变，只多一次哈希成本）；文件读失败**不**标 missing
 * （可能是暂态错误），只记入 `errors` 并保留旧行。
 */

import { createHash } from "node:crypto";
import { glob, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseMarkdownDocument, type SectionNode } from "@dsh-toolset/md-logic";

/** 文档索引的固定检索标签（§7.2「标签名由实现定」；非注册分类，见 `knowledge.ts` 并集面）。 */
export const DOC_INDEX_KIND = "doc";

/** 摘要行长度上限（与 `knowledge.ts` compress 的单行摘要口径一致）。 */
const SUMMARY_MAX_CHARS = 300;

export type DocStatus = "present" | "stale" | "missing";

export interface DocScanOptions {
  /** glob 模式列表（相对 `root` 解析；**空数组 = 不扫描**，P / U 缺省不索引）。 */
  include: readonly string[];
  /** glob 与 doc_ref 的解析根（P = 项目根，U = 家目录）。 */
  root: string;
  /** 归属项目键（P 库 = 项目键；U 库 = 空串 = 对所有项目可见）。 */
  project?: string;
  now?: number;
  /**
   * 进程内判变缓存（doc_ref → 上次扫描的 mtime / size / hash）：mtime+size 命中即跳过重哈希，
   * 未命中或未传则全量重算。由调用方持有（每库一份）。
   */
  cache?: Map<string, { mtimeMs: number; size: number; hash: string }>;
}

export interface DocScanReport {
  /** 本次 glob 展开到的文件数。 */
  scanned: number;
  /** 内容有变（或首次入索引）而重建行的文件数。 */
  changed: number;
  /** 内容与行均未变而跳过的文件数。 */
  unchanged: number;
  /** 从扫描集消失而被标 `missing` 的文件数。 */
  missing: number;
  /** 读文件 / 解析失败（旧行保留不动）。 */
  errors: Array<{ ref: string; error: string }>;
}

interface DocRow {
  line_start: number;
  line_end: number;
  section_title: string | null;
  summary: string | null;
  doc_hash: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 展平节树为一节一行（父节行范围含子节，按 §7.2「章节标题 + 行范围」口径原样记录）。 */
function flattenSections(
  nodes: readonly SectionNode[],
  out: Array<{ level: number; title: string; line: number; endLine: number }>,
): void {
  for (const node of nodes) {
    out.push({
      level: node.level,
      title: node.title,
      line: node.line,
      endLine: node.endLine,
    });
    flattenSections(node.children, out);
  }
}

/** 节内第一行非空、非标题的正文行（剥列表 / 引用标记，截到 300 字符）；容器节返回 null。 */
function summaryOfSection(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string | null {
  for (let i = startLine; i <= endLine; i += 1) {
    const raw = lines[i - 1] ?? "";
    const text = raw.trim();
    if (text.length === 0 || text.startsWith("#")) continue;
    // 剥一层列表 / 引用标记：摘要行进 FTS，保留标记只会污染匹配。
    const stripped = text
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^>\s?/, "");
    return stripped.slice(0, SUMMARY_MAX_CHARS);
  }
  return null;
}

/** 展开全部 glob（相对 root），返回绝对路径集合；模式为空 → 空集（不扫描）。 */
async function expandFiles(
  include: readonly string[],
  root: string,
): Promise<Set<string>> {
  const files = new Set<string>();
  for (const pattern of include) {
    for await (const entry of glob(pattern, { cwd: root })) {
      files.add(resolve(root, entry));
    }
  }
  return files;
}

/**
 * 扫描一次文档索引（设计 §7.2）：只对 `include` 命中的文件维护行；
 * 扫描集外已有 `present` / `stale` 行的文档 → 标 `missing`（不删行）。
 * 单次调用内事务包裹（差异写入原子）。
 */
export async function scanDocs(
  db: DatabaseSync,
  opts: DocScanOptions,
): Promise<DocScanReport> {
  const now = opts.now ?? Date.now();
  const project = opts.project ?? "";
  const report: DocScanReport = {
    scanned: 0,
    changed: 0,
    unchanged: 0,
    missing: 0,
    errors: [],
  };
  // 空 include = 功能关闭（P / U 缺省）：纯 no-op，不动库内已有行（配置摘掉 ≠ 全部 missing）。
  if (opts.include.length === 0) return report;
  const files = await expandFiles(opts.include, opts.root);
  report.scanned = files.size;

  // 库内现行文档集合（present / stale 才参与 missing 判定；missing 行等文件回来时重建）。
  const known = new Set<string>();
  for (const row of db
    .prepare("SELECT DISTINCT doc_ref FROM doc_index WHERE status != 'missing'")
    .all() as Array<{ doc_ref: string }>) {
    known.add(row.doc_ref);
  }
  const rowHashes = new Map<string, string>();
  for (const row of db
    .prepare(
      "SELECT doc_ref, doc_hash FROM doc_index WHERE status != 'missing'",
    )
    .all() as Array<{ doc_ref: string; doc_hash: string }>) {
    rowHashes.set(row.doc_ref, row.doc_hash);
  }

  const delRows = db.prepare("DELETE FROM doc_index WHERE doc_ref = ?");
  const insert = db.prepare(
    `INSERT INTO doc_index
       (doc_ref, section_title, line_start, line_end, doc_hash, summary, status, project, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?)`,
  );

  db.exec("BEGIN");
  try {
    for (const ref of [...files].sort()) {
      // 判变：mtime + size 粗筛（缓存命中）→ hash 确认；库内 hash 一致即跳过重建。
      let hash: string | undefined;
      const cached = opts.cache?.get(ref);
      try {
        const info = await stat(ref);
        if (
          cached !== undefined &&
          cached.mtimeMs === info.mtimeMs &&
          cached.size === info.size
        ) {
          hash = cached.hash;
        } else {
          const text = await readFile(ref, "utf8");
          hash = sha256(text);
          opts.cache?.set(ref, {
            mtimeMs: info.mtimeMs,
            size: info.size,
            hash,
          });
        }
      } catch (error) {
        report.errors.push({ ref, error: String(error) });
        continue;
      }
      if (rowHashes.get(ref) === hash) {
        report.unchanged += 1;
        continue;
      }
      let rows: DocRow[];
      try {
        const text = await readFile(ref, "utf8");
        const lines = text
          .replace(/^\uFEFF/, "")
          .replace(/\r\n?/g, "\n")
          .split("\n");
        const doc = parseMarkdownDocument(text);
        const flat: Array<{
          level: number;
          title: string;
          line: number;
          endLine: number;
        }> = [];
        flattenSections(doc.sections, flat);
        const fileHash: string = hash ?? "";
        rows = flat.map((section) => ({
          line_start: section.line,
          line_end: section.endLine,
          section_title: section.title,
          summary: summaryOfSection(lines, section.line, section.endLine),
          doc_hash: fileHash,
        }));
      } catch (error) {
        report.errors.push({ ref, error: String(error) });
        continue;
      }
      delRows.run(ref);
      for (const row of rows) {
        insert.run(
          ref,
          row.section_title,
          row.line_start,
          row.line_end,
          row.doc_hash,
          row.summary,
          project,
          now,
        );
      }
      report.changed += 1;
    }
    // 扫描集外的现行文档 → 标 missing（文件消失；不删行，§7.1 不自作主张）。
    for (const ref of known) {
      if (files.has(ref)) continue;
      db.prepare(
        "UPDATE doc_index SET status = 'missing' WHERE doc_ref = ? AND status != 'missing'",
      ).run(ref);
      report.missing += 1;
    }
    db.exec("COMMIT");
    return report;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
