/**
 * 事件编排层：订阅宿主 session/event 的 tool/result，完成
 * 触发判定 → 读取完整输出 → 沙箱派生 → 结构化摘要入 **自持 digest.db** →
 * `is_error` 行经 promote 服务面推 I→S 候选（决策 D62）。
 *
 * 事件处理绝不向宿主抛错：任何失败记录告警并跳过（digest.db 数据面无网络/挂载
 * 依赖，无 KbNotMounted 退避链——落点解析失败在 index.ts 判定，管线直接跳过）。
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

import {
  openDigestDatabase,
  pruneDigests,
  putDigest,
  type DigestRecord,
} from "./digest-db.ts";
import type { SummaryJson } from "./summary-program.ts";
import type { SandboxRunner } from "./sandbox.ts";
import { shouldCompress } from "./trigger.ts";
import { renderSummaryRecord } from "./render.ts";

/** session/event 事件的最小结构化视图。 */
export interface SessionEventLike {
  type: string;
  seq?: number;
  data?: unknown;
  ignorable?: true;
}

/** promote 服务面（memory-base 'memory' provide 的宽松子集；缺失 = 不提升、留待重推）。 */
export interface PromoteServiceLike {
  promote?(items: readonly unknown[]): Promise<unknown[]>;
}

/** 处理结果（测试断言用）。 */
export type CompressOutcome =
  | { status: "none" }
  | { status: "skipped"; reason: string }
  | {
      status: "written";
      digestId: number;
      bytes: number;
      toolName: string | null;
    };

export interface CompressOptions {
  /** 无 spill 通知时触发压缩的最小文本字节数（UTF-8）。 */
  minBytes: number;
  /** 从 spill 文件读取完整输出的字节上限。 */
  maxSourceBytes: number;
  /** digest.db 文件路径（index.ts 按 D60-b 判据解析；null = 落点不可得，管线跳过）。 */
  digestDbPath: string | null;
  /** promote 服务面（ctx.reflect.get('memory')；缺失 = 候选不入队，digest 行保持未推）。 */
  promote?: PromoteServiceLike;
  sandbox: SandboxRunner;
  logger: { info(message: string): void };
}

/** 已处理事件去重表上限（防止单会话超长会话内存膨胀）。 */
const PROCESSED_CAP = 1024;
/** callId → toolName 跟踪表上限。 */
const CALL_NAMES_CAP = 256;
/** 每轮 I→S push 的候选上限（§8.1：I→S ≤20）。 */
const PUSH_LIMIT = 20;
/** digest 预览截断长度（属概括，非正文）。 */
const PREVIEW_MAX_CHARS = 600;

/** 从 tool/result 事件载荷提取工具结果的纯文本表示。 */
export function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(extractText)
      .filter((s) => s.length > 0)
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return extractText(record.content);
    if (record.message !== undefined) return extractText(record.message);
  }
  return "";
}

/** 递归探测工具结果错误标记（block 级 isError 或 data 级 error 对象）。 */
function findIsError(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => findIsError(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (record.isError === true) return true;
  if (
    record.error !== undefined &&
    record.error !== null &&
    typeof record.error === "object"
  ) {
    return true;
  }
  return findIsError(record.content, depth + 1);
}

/** 从 tool/result 载荷提取 callId（用于关联 tool/call 的 toolName）。 */
function extractCallId(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractCallId(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.callId === "string") return record.callId;
  // 0.1.5-rc.2 tool-result 块把关联键放在 toolCallId 字段
  if (typeof record.toolCallId === "string") return record.toolCallId;
  if (record.source !== null && typeof record.source === "object") {
    const source = record.source as Record<string, unknown>;
    if (typeof source.callId === "string") return source.callId;
  }
  const foundInMessage = extractCallId(record.message, depth + 1);
  if (foundInMessage !== null) return foundInMessage;
  // tool-result 块位于 message.content[] 下，需沿 content 继续下钻
  return findCallIdDeep(record.content, depth + 1);
}

function findCallIdDeep(value: unknown, depth: number): string | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractCallId(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  return extractCallId(value, depth + 1);
}

/**
 * output-compress 事件钩子。
 * 生命周期：attach 订阅 session/event；detach 反订阅（幂等）。
 */
export class OutputCompressHooks {
  private detachFn: (() => void) | null = null;
  private processed = new Set<string>();
  private callNames = new Map<string, string>();
  /** digest.db 连接（懒开一次；路径 null = 永远跳过）。 */
  private digestDb: import("node:sqlite").DatabaseSync | null = null;
  private digestOpenFailed = false;

  constructor(private readonly options: CompressOptions) {}

  attach(host: {
    on(
      event: "session/event",
      callback: (session: { id: string }, event: SessionEventLike) => void,
    ): void | (() => void);
  }): () => void {
    const handle = host.on("session/event", (session, event) => {
      this.handle(session.id, event);
    });
    this.detachFn = typeof handle === "function" ? handle : null;
    return () => this.detach();
  }

  detach(): void {
    if (this.detachFn !== null) {
      this.detachFn();
      this.detachFn = null;
    }
  }

  handle(sessionId: string, event: SessionEventLike): void {
    if (event.type === "tool/call" && event.data !== undefined) {
      const record = event.data as Record<string, unknown>;
      if (
        typeof record.callId === "string" &&
        typeof record.name === "string"
      ) {
        this.rememberCallName(record.callId, record.name);
      }
      return;
    }
    if (event.type !== "tool/result" || event.data === undefined) return;
    void this.process(sessionId, event);
  }

  async process(
    sessionId: string,
    event: SessionEventLike,
  ): Promise<CompressOutcome> {
    const data = event.data;
    if (data === undefined) return { status: "none" };
    try {
      return await this.#runPipeline(sessionId, event, data);
    } catch (error) {
      const reason = `compress-failed: ${String(error)}`;
      this.options.logger.info(`output-compress 跳过: ${reason}`);
      return { status: "skipped", reason };
    }
  }

  async #runPipeline(
    sessionId: string,
    event: SessionEventLike,
    data: unknown,
    bypassDedupe = false,
  ): Promise<CompressOutcome> {
    // 落点判据（D60-b）：index.ts 解析失败传 null → 跳过（该会话 I→S 判据整体失效）。
    if (this.options.digestDbPath === null) {
      return { status: "skipped", reason: "session-dir-missing" };
    }
    const dedupeKey = `${sessionId}:${event.seq ?? "n"}`;
    if (!bypassDedupe) {
      if (this.processed.has(dedupeKey)) return { status: "none" };
      this.rememberProcessed(dedupeKey);
    }

    const text = extractText(data);
    if (text.length === 0) return { status: "none" };
    const { reason, notice } = shouldCompress(text, {
      minBytes: this.options.minBytes,
    });
    if (reason === "none") return { status: "none" };

    let sourceText: string;
    let totalBytes: number;
    let locator: string | null = null;
    let retrievalHint = "";
    if (reason === "spill-notice" && notice !== null) {
      locator = notice.locator;
      retrievalHint = notice.retrievalHint;
      const read = await this.readSpillSource(notice.locator);
      if (read !== null) {
        sourceText = read.text;
        totalBytes = read.bytes;
      } else {
        this.options.logger.info(
          `output-compress: spill 文件不可读，退化为事件文本: ${locator}`,
        );
        sourceText = text;
        totalBytes = Buffer.byteLength(text, "utf8");
      }
    } else {
      sourceText = text;
      totalBytes = Buffer.byteLength(text, "utf8");
    }

    const summary: SummaryJson = await this.options.sandbox.run(sourceText);
    const callId = extractCallId(data);
    const toolName =
      callId !== null ? (this.callNames.get(callId) ?? null) : null;
    const isError = findIsError(data);
    const record = renderSummaryRecord({
      sessionId,
      seq: typeof event.seq === "number" ? event.seq : null,
      toolName,
      locator,
      retrievalHint,
      totalBytes,
      scannedBytes: Buffer.byteLength(sourceText, "utf8"),
      truncated:
        reason === "spill-notice" && totalBytes > this.options.maxSourceBytes,
      summary,
    });

    // 自持 digest.db：懒开（连接级缓存；开失败 = 告警 + skipped，不进退避链）。
    const db = this.ensureDigestDb();
    if (db === null)
      return { status: "skipped", reason: "digest-db-open-failed" };
    const digest: DigestRecord = {
      sessionId,
      tool: toolName ?? "unknown",
      locator,
      seq: typeof event.seq === "number" ? event.seq : null,
      headings: summary.headings,
      keyLines: summary.keyLines,
      slices: summary.slices,
      fingerprint: summary.textFnv,
      preview: record.slice(0, PREVIEW_MAX_CHARS),
      isError,
      contentHash: createHash("sha256")
        .update(sourceText, "utf8")
        .digest("hex"),
    };
    const put = putDigest(db, digest);
    if (put.status === "rejected") {
      this.options.logger.info(
        `output-compress 拒写（隐私底线 deny-pattern）: ${put.reason}`,
      );
      return { status: "skipped", reason: `deny-pattern: ${put.reason}` };
    }
    const digestId = put.id ?? 0;
    // is_error 行立即推 I→S 候选（决策 D62）；普通行靠 referenced_at 判据走巩固重推。
    if (isError) await this.pushDigest(db, digestId, digest, record);
    this.options.logger.info(
      `output-compress 入库: session=${sessionId.slice(0, 8)} seq=${
        event.seq ?? "n"
      } tool=${toolName ?? "unknown"} bytes=${totalBytes} digest=${put.status}`,
    );
    return {
      status: "written",
      digestId,
      bytes: totalBytes,
      toolName,
    };
  }

  /** 懒开 digest.db（连接级缓存；开失败置标志，不再逐事件重试）。 */
  private ensureDigestDb(): import("node:sqlite").DatabaseSync | null {
    if (this.digestDb !== null) return this.digestDb;
    if (this.digestOpenFailed) return null;
    if (this.options.digestDbPath === null) return null;
    try {
      this.digestDb = openDigestDatabase(this.options.digestDbPath);
      return this.digestDb;
    } catch (error: unknown) {
      this.digestOpenFailed = true;
      this.options.logger.info(
        `output-compress: digest.db 打开失败（跳过写入）：${String(error)}`,
      );
      return null;
    }
  }

  /**
   * 推一条 I→S 候选（决策 D62）并记录 push 状态（D60-a 列）：queued / merged 入账、
   * rejected 计数；promote 缺失 = 不推（digest 行保持 none，等巩固重推）。
   */
  private async pushDigest(
    db: import("node:sqlite").DatabaseSync,
    digestId: number,
    digest: DigestRecord,
    rendered: string,
  ): Promise<void> {
    const promote = this.options.promote?.promote;
    if (typeof promote !== "function") return;
    const outcomes = (await promote([
      {
        targetTier: "session",
        kind: "digest",
        title: `output-compress ${digest.tool} ${digest.sessionId.slice(0, 8)}#${digest.seq ?? "n"}`,
        content: rendered,
        sources: [`digest:${digest.sessionId}:${digestId}`],
      },
    ])) as Array<{ status?: string }> | undefined;
    const outcome = outcomes?.[0];
    const state =
      outcome?.status === "queued"
        ? "queued"
        : outcome?.status === "merged"
          ? "merged"
          : outcome?.status === "rejected-duplicate"
            ? "merged"
            : "rejected";
    db.prepare(
      "UPDATE digests SET push_state = ?, pushed_at = ?, pushed_content_hash = ? WHERE id = ?",
    ).run(state, Date.now(), digest.contentHash, digestId);
  }

  /**
   * 巩固重推（设计 §6「重推在属主巩固时」，决策 D63）：扫 is_error 或被回查引用过、
   * 且（未推或推后被再次引用）的 digests 重推；每轮 ≤20；随后容量自查。
   */
  async promotePending(): Promise<{ pushed: number; pruned: number }> {
    const db = this.ensureDigestDb();
    if (db === null) return { pushed: 0, pruned: 0 };
    const rows = db
      .prepare(
        `SELECT id, session_id, tool, seq, locator, preview, is_error, content_hash, referenced_at, created_at
         FROM digests
         WHERE (is_error = 1 OR referenced_at > created_at)
           AND (push_state = 'none' OR (referenced_at > COALESCE(pushed_at, 0) AND push_state != 'rejected'))
         ORDER BY created_at ASC LIMIT ${PUSH_LIMIT}`,
      )
      .all() as Array<{
      id: number;
      session_id: string;
      tool: string;
      seq: number | null;
      locator: string | null;
      preview: string;
      is_error: number;
      content_hash: string;
    }>;
    const promote = this.options.promote?.promote;
    let pushed = 0;
    if (typeof promote === "function" && rows.length > 0) {
      const items = rows.map((row) => ({
        targetTier: "session",
        kind: "digest",
        title: `output-compress ${row.tool} ${row.session_id.slice(0, 8)}#${row.seq ?? "n"}`,
        content: row.preview,
        sources: [`digest:${row.session_id}:${row.id}`],
      }));
      const outcomes = (await promote(items)) as Array<{ status?: string }>;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        const outcome = outcomes[i];
        const state =
          outcome?.status === "queued"
            ? "queued"
            : outcome?.status === "merged"
              ? "merged"
              : outcome?.status === "rejected-duplicate"
                ? "merged"
                : "rejected";
        if (state !== "rejected") pushed += 1;
        db.prepare(
          "UPDATE digests SET push_state = ?, pushed_at = ?, pushed_content_hash = ? WHERE id = ?",
        ).run(state, Date.now(), row.content_hash, row.id);
      }
    }
    const pruned = pruneDigests(db);
    return { pushed, pruned };
  }

  private rememberCallName(callId: string, name: string): void {
    if (this.callNames.size >= CALL_NAMES_CAP) this.callNames.clear();
    this.callNames.set(callId, name);
  }

  private rememberProcessed(key: string): void {
    if (this.processed.size >= PROCESSED_CAP) this.processed.clear();
    this.processed.add(key);
  }

  private async readSpillSource(
    locator: string,
  ): Promise<{ text: string; bytes: number } | null> {
    const now = Date.now();
    if (now < this.openBackoffUntil) return null;
    try {
      const totalBytes = (await stat(locator)).size;
      const readBytes = Math.min(totalBytes, this.options.maxSourceBytes);
      const handle = await open(locator, "r");
      let text: string;
      try {
        const buf = Buffer.alloc(readBytes);
        const { bytesRead } = await handle.read(buf, 0, readBytes, 0);
        text = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
      return { text, bytes: totalBytes };
    } catch {
      this.openBackoffUntil = now + 10_000;
      return null;
    }
  }

  /** spill 读取失败退避窗口（防每次事件都试同一缺失文件）——与库挂载无关。 */
  private openBackoffUntil = 0;
}
