/**
 * 事件编排层：订阅宿主 session/event 的 tool/result，完成
 * 触发判定 → 读取完整输出 → 沙箱派生 → 结构化摘要入 **自持 digest.db** →
 * `is_error` 行经 memory-base 的**作用域句柄** `put` 写入（决策 D62；2026-10-17
 * 重定：`promote` 已取消，改由本包注册 `digest` 分类、自持写入判据）。
 *
 * 事件处理绝不向宿主抛错：任何失败记录告警并跳过（digest.db 数据面无网络/挂载
 * 依赖，无 KbNotMounted 退避链——落点按会话推导失败时管线直接跳过）。
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";

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

/** 分层并集（与 memory-base 的 `Tier` 对齐；本包只写 `session`）。 */
export type MemoryTier = "session" | "project" | "user";

/** 句柄 `put` 的入参（memory-base `ScopePutInput` 的宽松子集）。 */
export interface ScopePutInputLike {
  content: string;
  tier?: MemoryTier;
  sessionId?: string;
  project?: string;
  title?: string;
  importance?: number;
  source?: { kind: string; ref: string; label?: string };
}

/** 句柄 `put` 的返回值（memory-base `PutResult` 的宽松子集）。 */
export interface PutResultLike {
  ids?: readonly number[];
  sourceId?: number;
  created?: number;
  /** 内容级闸门（隐私闸 / preWrite）拒写原因；有值 = 拒写。 */
  skipped?: { reason?: string };
}

/** 写入作用域句柄（memory-base `registerKind` 的返回值；缺失 = 不入库、留待重推）。 */
export interface MemoryScopeLike {
  readonly kind?: string;
  readonly writableTiers?: readonly MemoryTier[];
  put?(input: ScopePutInputLike): Promise<PutResultLike> | PutResultLike;
  forget?(refs: readonly unknown[]): Promise<number> | number;
}

/** session-paths 服务面（可选依赖；缺面 = digest 落点不可推导）。 */
export interface SessionPathsLike {
  /** 按会话 id 直接给会话目录（同步；取 cwd 在 session-paths 内部完成）。 */
  sessionDirFor(sessionId: string): string;
}

/** 一次推送的三种结果（对齐 memory-base 的错误形态分档）。 */
export type DigestPushResult =
  /** 写入成功（`put` 返回非空 ids 且无 skipped）。 */
  | { state: "queued"; ids: number[] }
  /** 内容级拒写或参数级抛错：**不重试**（重试也不会通过，或属编程错误）。 */
  | { state: "rejected"; reason: string }
  /** 能力缺失（无句柄 / 无会话 id）：保持 `none`，等巩固重推。 */
  | { state: "pending"; reason: string };

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
  /**
   * digest.db 落点（决策项 9）：`undefined` = 未配置，按会话经 sessionPaths 推导；
   * `null` = 配了显式覆盖但目录不可用（跳过，不回落推导）；字符串 = 显式覆盖路径。
   */
  digestDbPath?: string | null;
  /** memory-base 的 `digest` 分类写入句柄（缺失 = 不入库，digest 行保持 `none` 待重推）。 */
  scope?: MemoryScopeLike;
  /** 句柄的惰性解析（句柄可能晚于本包挂载；每次写入前重试一次）。 */
  getScope?: () => MemoryScopeLike | undefined;
  /** session-paths 服务（缺失 = 落点不可推导 → `skipped.session-dir-missing`）。 */
  sessionPaths?: SessionPathsLike;
  sandbox: SandboxRunner;
  logger: { info(message: string): void };
}

/** 已处理事件去重表上限（防止单会话超长会话内存膨胀）。 */
const PROCESSED_CAP = 1024;
/** callId → toolName 跟踪表上限。 */
const CALL_NAMES_CAP = 256;
/** 每轮巩固重推的行数上限（§8.1：I→S ≤20）。 */
const PUSH_LIMIT = 20;
/** digest 预览截断长度（属概括，非正文）。 */
const PREVIEW_MAX_CHARS = 600;
/** digest.db 文件名（每会话一个文件，落在会话目录内）。 */
const DIGEST_DB_FILENAME = "digest.db";
/** 同时保持打开的会话库连接上限（超出按最早打开淘汰）。 */
const DIGEST_DB_CONNECTIONS_CAP = 32;

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
  /** 每会话 digest.db 连接（决策项 9：每会话一个文件；按路径懒开、按上限淘汰）。 */
  private digestDbs = new Map<string, import("node:sqlite").DatabaseSync>();
  /** 打开失败的路径（不再逐事件重试）。 */
  private digestOpenFailed = new Set<string>();
  /** 一次性提示已发出的键（缺 memory-base / 缺 session-paths 等）。 */
  private logged = new Set<string>();

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
    this.closeDatabases();
  }

  /** 关闭全部会话库连接（dispose / detach 时调用；幂等）。 */
  closeDatabases(): void {
    for (const db of this.digestDbs.values()) {
      try {
        db.close();
      } catch {
        // 关闭失败不影响进程退出。
      }
    }
    this.digestDbs.clear();
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
    // 落点判据（决策项 9）：显式覆盖 / 按会话经 sessionPaths 推导；不可得 → 跳过该会话。
    const digestPath = this.resolveDigestPath(sessionId);
    if (digestPath === null) {
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

    // 自持 digest.db：按会话懒开（连接级缓存；开失败 = 告警 + skipped，不进退避链）。
    const db = this.ensureDigestDb(digestPath);
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
    // is_error 行立即经句柄写入 memory-base（决策 D62）；普通行留待巩固重推。
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

  /**
   * 解析某会话的 digest.db 路径（决策项 9）：显式覆盖优先；否则经 session-paths
   * 服务的 `sessionDirFor(sessionId)` 推导（同步，取 cwd 收在该服务内部）。
   * 返回 null = 落点不可得（服务缺失 / 会话取不到 / 抛错），调用方记 skipped。
   */
  private resolveDigestPath(sessionId: string): string | null {
    const override = this.options.digestDbPath;
    if (override === null) return null;
    if (typeof override === "string") return override;
    const service = this.options.sessionPaths;
    if (service === undefined) {
      this.logOnce(
        "session-paths-missing",
        "output-compress: session-paths 服务未挂载，digest.db 落点不可推导 —— 管线按 skipped.session-dir-missing 跳过（digest 不入库）",
      );
      return null;
    }
    try {
      const dir = service.sessionDirFor(sessionId);
      if (typeof dir !== "string" || dir === "") {
        this.logOnce(
          `session-dir-empty:${sessionId}`,
          `output-compress: sessionDirFor 返回空路径（会话 ${sessionId.slice(0, 8)}），跳过该会话 digest`,
        );
        return null;
      }
      return join(dir, DIGEST_DB_FILENAME);
    } catch (error: unknown) {
      this.logOnce(
        `session-dir-error:${sessionId}`,
        `output-compress: sessionDirFor 失败（会话 ${sessionId.slice(0, 8)}），跳过该会话 digest：${String(error)}`,
      );
      return null;
    }
  }

  /** 懒开某会话的 digest.db（连接级缓存；开失败置标志，不再逐事件重试该路径）。 */
  private ensureDigestDb(
    path: string,
  ): import("node:sqlite").DatabaseSync | null {
    const existing = this.digestDbs.get(path);
    if (existing !== undefined) return existing;
    if (this.digestOpenFailed.has(path)) return null;
    try {
      const db = openDigestDatabase(path);
      this.rememberDigestDb(path, db);
      return db;
    } catch (error: unknown) {
      this.digestOpenFailed.add(path);
      this.options.logger.info(
        `output-compress: digest.db 打开失败（跳过写入）：${String(error)}`,
      );
      return null;
    }
  }

  /** 记入连接缓存（超上限时关掉最早打开的那个，防止多会话下连接无限增长）。 */
  private rememberDigestDb(
    path: string,
    db: import("node:sqlite").DatabaseSync,
  ): void {
    if (this.digestDbs.size >= DIGEST_DB_CONNECTIONS_CAP) {
      const oldest = this.digestDbs.keys().next().value;
      if (oldest !== undefined) {
        try {
          this.digestDbs.get(oldest)?.close();
        } catch {
          // 淘汰时的关闭失败不影响后续。
        }
        this.digestDbs.delete(oldest);
      }
    }
    this.digestDbs.set(path, db);
  }

  /**
   * 经作用域句柄写入一行摘要（决策项 5 的三种结果分档）：成功 → `queued`；
   * 内容级 `PutResult.skipped` 与参数/权限级抛错 → `rejected`（不重试）；
   * 能力缺失（无句柄 / 无会话 id）→ `pending`（保持 `none`，等巩固重推）。
   */
  private async putDigestRow(input: {
    digestId: number;
    sessionId: string;
    tool: string;
    seq: number | null;
    isError: boolean;
    content: string;
  }): Promise<DigestPushResult> {
    const scope = this.options.getScope?.() ?? this.options.scope;
    if (scope === undefined || typeof scope.put !== "function") {
      this.logOnce(
        "memory-scope-missing",
        "output-compress: memory-base 未挂载（无 digest 分类写入句柄）—— digest 只留本地 digest.db，不入知识库",
      );
      return { state: "pending", reason: "memory-scope-missing" };
    }
    if (input.sessionId === "") {
      return { state: "pending", reason: "session-id-missing" };
    }
    const payload: ScopePutInputLike = {
      content: input.content,
      tier: "session",
      sessionId: input.sessionId,
      title: `output-compress ${input.tool} ${input.sessionId.slice(0, 8)}#${input.seq ?? "n"}`,
      importance: input.isError ? 4 : 2,
      source: {
        kind: "tool_result",
        ref: `digest:${input.sessionId}:${input.digestId}`,
        label: input.tool,
      },
    };
    try {
      const result = await scope.put(payload);
      if (result?.skipped !== undefined) {
        const reason = result.skipped.reason ?? "skipped";
        this.logOnce(
          `put-skipped:${reason}`,
          `output-compress: 句柄拒写（内容级，不重试）: ${reason}`,
        );
        return { state: "rejected", reason };
      }
      const ids = Array.isArray(result?.ids) ? [...result.ids] : [];
      if (ids.length === 0) {
        this.logOnce(
          "put-empty-ids",
          "output-compress: 句柄写入未返回行 id（视为拒写，不重试）",
        );
        return { state: "rejected", reason: "empty-ids" };
      }
      return { state: "queued", ids };
    } catch (error: unknown) {
      this.logOnce(
        `put-error:${String(error)}`,
        `output-compress: 句柄写入抛错（参数/权限级，不重试）: ${String(error)}`,
      );
      return { state: "rejected", reason: `put-error: ${String(error)}` };
    }
  }

  /** 记录 push 状态（`pending` 落库为 `none`，其余原样）；`none` 不写 pushed_*。 */
  private recordPushState(
    db: import("node:sqlite").DatabaseSync,
    digestId: number,
    state: DigestPushResult["state"],
    contentHash: string,
  ): void {
    db.prepare(
      "UPDATE digests SET push_state = ?, pushed_at = ?, pushed_content_hash = ? WHERE id = ?",
    ).run(
      state === "pending" ? "none" : state,
      state === "pending" ? null : Date.now(),
      state === "pending" ? null : contentHash,
      digestId,
    );
  }

  /**
   * 推一条 `is_error` digest（决策 D62）并记录 push 状态（D60-a 列）；
   * 句柄缺失时行保持 `none`，等 `promotePending` 重试。
   */
  private async pushDigest(
    db: import("node:sqlite").DatabaseSync,
    digestId: number,
    digest: DigestRecord,
    rendered: string,
  ): Promise<DigestPushResult> {
    const result = await this.putDigestRow({
      digestId,
      sessionId: digest.sessionId,
      tool: digest.tool,
      seq: digest.seq,
      isError: digest.isError,
      content: rendered,
    });
    this.recordPushState(db, digestId, result.state, digest.contentHash);
    return result;
  }

  /**
   * 巩固重推（设计 §6「重推在属主巩固时」，决策 D63 / 决策项 5a）：扫**本进程已打开**
   * 的会话库里「能力缺失导致未推」的行重试；每库每轮 ≤20；不重复写（幂等）；
   * 内容级拒写与抛错已落 `rejected`，不再进入本查询。随后各库容量自查。
   */
  async promotePending(): Promise<{ pushed: number; pruned: number }> {
    const dbs = this.databasesForSweep();
    let pushed = 0;
    let pruned = 0;
    for (const db of dbs) {
      const rows = db
        .prepare(
          `SELECT id, session_id, tool, seq, preview, is_error, content_hash
           FROM digests
           WHERE (is_error = 1 OR referenced_at > created_at)
             AND push_state = 'none'
           ORDER BY created_at ASC LIMIT ${PUSH_LIMIT}`,
        )
        .all() as Array<{
        id: number;
        session_id: string;
        tool: string;
        seq: number | null;
        preview: string;
        is_error: number;
        content_hash: string;
      }>;
      for (const row of rows) {
        const result = await this.putDigestRow({
          digestId: row.id,
          sessionId: row.session_id,
          tool: row.tool,
          seq: row.seq,
          isError: row.is_error === 1,
          content: row.preview,
        });
        this.recordPushState(db, row.id, result.state, row.content_hash);
        if (result.state === "queued") pushed += 1;
      }
      pruned += pruneDigests(db);
    }
    return { pushed, pruned };
  }

  /** 待重推行数（`push_state = 'none'` 且命中重推判据；测试与运维观测用）。 */
  pendingPushCount(): number {
    let total = 0;
    for (const db of this.databasesForSweep()) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM digests
           WHERE (is_error = 1 OR referenced_at > created_at) AND push_state = 'none'`,
        )
        .get() as { n: number };
      total += Number(row.n);
    }
    return total;
  }

  /** 巩固重推扫的库集合：已打开的会话库；显式覆盖路径未打开时也纳入。 */
  private databasesForSweep(): import("node:sqlite").DatabaseSync[] {
    if (
      this.digestDbs.size === 0 &&
      typeof this.options.digestDbPath === "string"
    ) {
      const db = this.ensureDigestDb(this.options.digestDbPath);
      if (db !== null) return [db];
    }
    return [...this.digestDbs.values()];
  }

  private rememberCallName(callId: string, name: string): void {
    if (this.callNames.size >= CALL_NAMES_CAP) this.callNames.clear();
    this.callNames.set(callId, name);
  }

  /** 一次性提示（同一 key 只发一次，避免逐事件刷屏）。 */
  private logOnce(key: string, message: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.options.logger.info(message);
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
