/**
 * 共享库写入层：把摘要记录写入 knowledge-base 的同一 SQLite 库（宿主共享面）。
 *
 * 硬约束：不引入 knowledge-base 的 npm 依赖，也不创建任何表——
 * 表结构与 FTS5 索引由 knowledge-base 插件持有，本层只做：
 *  1. 写前校验库指纹（PRAGMA application_id = 'KNOW'、user_version = 1）与必备表；
 *  2. 按 content_hash 去重（与 knowledge-base 同一去重键）；
 *  3. 插入 sources + chunks（FTS5 由库内触发器自动同步）。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";

/** knowledge-base 库指纹：application_id = 0x4B4E4F57（'KNOW'）。 */
export const KB_APPLICATION_ID = 0x4b4e4f57;
/** knowledge-base 库 schema 版本。 */
export const KB_SCHEMA_VERSION = 1;
/** 单 chunk 的 token 预算（对齐 knowledge-base 的 MAX_TOKENS）。 */
const CHUNK_TOKEN_BUDGET = 2000;
/** token 估算（对齐 knowledge-base：1 token ≈ 3 字符）。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * dbPath 解析顺序（见 DESIGN.md）：
 * 显式 config > OUTPUT_COMPRESS_DB_PATH > KNOWLEDGE_DB_PATH > ~/.dsh/knowledge-base/knowledge.db
 */
export function resolveDbPath(configDbPath?: string): string {
  if (typeof configDbPath === "string" && configDbPath.length > 0) {
    return configDbPath;
  }
  const fromEnv =
    process.env.OUTPUT_COMPRESS_DB_PATH ?? process.env.KNOWLEDGE_DB_PATH;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(homedir(), ".dsh", "knowledge-base", "knowledge.db");
}

/** 库未挂载（不存在/指纹不符/表缺失）时抛出，调用方捕获后跳过写入。 */
export class KbNotMountedError extends Error {}

/** 待入库的摘要记录（结构化输入，与 knowledge-base 的 PutInput 同形状约定）。 */
export interface KbPutInput {
  project: string;
  title: string;
  content: string;
  category: string;
  target: string;
  /** 1-5（对齐 knowledge-base 取值）。 */
  importance: number;
  sessionId?: string;
  source: {
    kind: string;
    label?: string;
    ref?: string;
  };
}

/** 写入结果。 */
export interface KbPutResult {
  /** 本次涉及的 chunk id（含去重命中的既有 id）。 */
  ids: number[];
  sourceId: number;
  /** 实际新插入的 chunk 数（去重命中为 0）。 */
  created: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 按 markdown 段落边界切 chunk，超预算硬切（移植 knowledge-base 的 chunkContent 行为，
 * 保持两插件的 chunk 语义一致：预算 2000 token ≈ 6000 字符）。
 */
export function chunkContent(content: string): string[] {
  const hardLimit = CHUNK_TOKEN_BUDGET * 3;
  const paragraphs = content.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (estimateTokens(candidate) <= CHUNK_TOKEN_BUDGET) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
    if (estimateTokens(para) > CHUNK_TOKEN_BUDGET) {
      for (let i = 0; i < para.length; i += hardLimit) {
        chunks.push(para.slice(i, i + hardLimit));
      }
    } else {
      current = para;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * 共享库写入器：惰性打开（首个 tool/result 时），指纹校验后持有连接。
 * 打开失败不抛出到事件回调——调用方（hooks）捕获后记录并跳过，下次事件重试。
 */
export class SharedKbWriter {
  /** 打开后的共享连接（惰性）。 */
  private db: DatabaseSync | null = null;
  /**
   * @param dbPath 已解析的库文件路径
   * @param log 告警日志（指纹拒写等一次性事件）
   */
  constructor(
    private readonly dbPath: string,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /**
   * 打开并校验库；指纹不符或表缺失时抛 KbNotMountedError 并关闭连接。
   * 注意：knowledge-base 尚未创建库文件时同样抛 KbNotMountedError（文件不存在）。
   */
  open(): DatabaseSync {
    if (this.db !== null) return this.db;
    if (!existsSync(this.dbPath)) {
      throw new KbNotMountedError(
        `knowledge-base 库不存在: ${this.dbPath}（knowledge-base bundle 未挂载或未初始化？）`,
      );
    }
    const db = new DatabaseSync(this.dbPath);
    let closed = false;
    try {
      // 写锁等待 2s：与 knowledge-base 的连接共存，避免 SQLITE_BUSY 直接抛错
      db.exec("PRAGMA busy_timeout = 2000");
      const { application_id: appId } = db
        .prepare("PRAGMA application_id")
        .get() as { application_id: number };
      const { user_version: version } = db
        .prepare("PRAGMA user_version")
        .get() as { user_version: number };
      if (appId !== KB_APPLICATION_ID || version !== KB_SCHEMA_VERSION) {
        db.close();
        closed = true;
        throw new KbNotMountedError(
          `knowledge-base 指纹不符（application_id=${appId
            .toString(16)
            .padStart(
              8,
              "0",
            )}, user_version=${version}），拒写: ${this.dbPath}`,
        );
      }
      const tables = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map((row) => row.name),
      );
      if (!tables.has("sources") || !tables.has("chunks")) {
        db.close();
        closed = true;
        throw new KbNotMountedError(
          `sources/chunks 表缺失，拒写: ${this.dbPath}`,
        );
      }
      this.db = db;
      return db;
    } catch (error) {
      if (!closed && this.db === null) db.close();
      throw error;
    }
  }

  /**
   * 写入摘要记录：全文 content_hash 去重（复用既有 source），chunk 级 content_hash 去重。
   * 与 knowledge-base 的 put() 同键同表，FTS5 由库内触发器自动同步。
   */
  put(input: KbPutInput): KbPutResult {
    const db = this.open();
    const now = Date.now();
    const importance = Math.max(1, Math.min(5, input.importance));
    const chunks = chunkContent(input.content);
    const fullHash = sha256(input.content);
    const existingSource = db
      .prepare(
        "SELECT id FROM sources WHERE content_hash = ? AND kind = ? LIMIT 1",
      )
      .get(fullHash, input.source.kind) as { id: number } | undefined;
    db.exec("BEGIN");
    try {
      // source 去重：同内容同 kind 复用既有行（与 knowledge-base 行为一致）
      const sourceId =
        existingSource === undefined
          ? Number(
              db
                .prepare(
                  `INSERT INTO sources (kind, label, ref, content_hash, chunk_count, created_at)
                   VALUES (?, ?, ?, ?, 0, ?)`,
                )
                .run(
                  input.source.kind,
                  input.source.label ?? null,
                  input.source.ref ?? null,
                  fullHash,
                  now,
                ).lastInsertRowid,
            )
          : Number(existingSource.id);
      const existingChunk = db.prepare(
        "SELECT id FROM chunks WHERE content_hash = ? LIMIT 1",
      );
      const insertChunk = db.prepare(
        `INSERT INTO chunks (
           source_id, project, target, category, title, content, content_hash,
           importance, session_id, last_referenced, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ids: number[] = [];
      let created = 0;
      for (const chunk of chunks) {
        const dup = existingChunk.get(sha256(chunk)) as
          { id: number } | undefined;
        if (dup !== undefined) {
          ids.push(Number(dup.id));
          continue;
        }
        const id = Number(
          insertChunk.run(
            sourceId,
            input.project,
            input.target,
            input.category,
            input.title,
            chunk,
            sha256(chunk),
            importance,
            input.sessionId ?? null,
            now,
            now,
          ).lastInsertRowid,
        );
        ids.push(id);
        created += 1;
      }
      if (created > 0) {
        db.prepare(
          "UPDATE sources SET chunk_count = chunk_count + ? WHERE id = ?",
        ).run(created, sourceId);
      }
      db.exec("COMMIT");
      return { ids, sourceId, created };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 关闭共享连接（bundle dispose / 测试收尾调用）。 */
  close(): void {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }
}
