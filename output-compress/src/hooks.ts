/**
 * 事件编排层：订阅宿主 session/event 的 tool/result，完成
 * 触发判定 → 读取完整输出 → 沙箱派生 → 摘要记录渲染 → 共享库写入。
 *
 * 事件处理绝不向宿主抛错：任何失败记录告警并跳过本次写入（下次事件重试打开）。
 */
import { readFile } from "node:fs/promises";

import {
  KbNotMountedError,
  type KbPutInput,
  SharedKbWriter,
} from "./kb-write.ts";
import { type SummaryJson } from "./summary-program.ts";
import type { SandboxRunner } from "./sandbox.ts";
import { shouldCompress } from "./trigger.ts";

/** 宿主钩子挂载面（最小结构化视图，与 knowledge-base 的 HookHost 同形）。 */
export interface HookHost {
  on(
    event: "session/event",
    callback: (session: { id: string }, event: SessionEventLike) => void,
  ): void | (() => void);
}

/** session/event 事件的最小结构化视图。 */
export interface SessionEventLike {
  type: string;
  seq?: number;
  data?: unknown;
  ignorable?: true;
}

/** 处理结果（测试断言用）。 */
export type CompressOutcome =
  | { status: "none" }
  | { status: "skipped"; reason: string }
  | {
      status: "written";
      chunks: number;
      bytes: number;
      toolName: string | null;
    };

export interface CompressOptions {
  /** 无 spill 通知时触发压缩的最小文本长度（字符）。 */
  minChars: number;
  /** 从 spill 文件读取完整输出的字节上限。 */
  maxSourceBytes: number;
  /** 入库 project（字符串或动态获取，如按 cwd 解析）。 */
  project: string | (() => string);
  writer: SharedKbWriter;
  sandbox: SandboxRunner;
  logger: { info(message: string): void };
  /** 库未挂载重试的退避延迟（ms）；缺省 [1000, 2500, 5000, 10000]，测试可注入短延迟。 */
  kbRetryDelays?: number[];
}

/** 已处理事件去重表上限（防止单会话超长会话内存膨胀）。 */
const PROCESSED_CAP = 1024;
/** callId → toolName 跟踪表上限。 */
const CALL_NAMES_CAP = 256;

/**
 * 从 tool/result 事件载荷提取工具结果的纯文本表示。
 * 最小实现（对齐 knowledge-base 的 extractText 行为）：
 * 字符串原样；数组递归拼接；对象取 text → content → message。
 */
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
  const found = extractCallId(record.message, depth + 1);
  if (found !== null) return found;
  // tool-result 块位于 message.content[] 下，需沿 content 继续下钻
  return extractCallId(record.content, depth + 1);
}

/**
 * 摘要记录渲染：确定性 markdown（同一 SummaryJson + 元数据 → 同一文本）。
 * 不含时间戳等运行期变量；原始字节绝不内联，只留 spill locator 与切片索引。
 */
export function renderSummaryRecord(params: {
  sessionId: string;
  seq: number | null;
  toolName: string | null;
  /** 完整输出的落盘位置；无 spill 通知时为 null（源即事件文本）。 */
  locator: string | null;
  retrievalHint: string;
  /** 完整输出的总字节数（通知的 omittedBytes 或事件文本字节数）。 */
  totalBytes: number;
  /** 实际参与派生的字节数（maxSourceBytes 截断后）。 */
  scannedBytes: number;
  truncated: boolean;
  summary: SummaryJson;
}): string {
  const {
    sessionId,
    seq,
    toolName,
    locator,
    retrievalHint,
    totalBytes,
    scannedBytes,
    truncated,
    summary,
  } = params;
  const lines: string[] = [];
  lines.push("# output-compress 摘要");
  lines.push("");
  lines.push(`- session: ${sessionId}`);
  lines.push(`- seq: ${seq ?? "unknown"}`);
  lines.push(`- tool: ${toolName ?? "unknown"}`);
  lines.push(
    locator !== null
      ? `- source: ${locator}`
      : "- source: inline-event-text（无 spill 通知，按阈值触发）",
  );
  if (retrievalHint.length > 0) lines.push(`- retrieval: ${retrievalHint}`);
  lines.push(`- totalBytes: ${totalBytes}`);
  lines.push(
    `- scannedBytes: ${scannedBytes}${truncated ? "（已按 maxSourceBytes 截断）" : ""}`,
  );
  lines.push(`- fingerprint(fnv1a32): ${summary.textFnv}`);
  lines.push(
    `- stats: lines=${summary.stats.lines} bytes=${summary.stats.bytes} ` +
      `maxLine=${summary.stats.maxLineLen} avgLine=${summary.stats.avgLineLen}`,
  );
  lines.push("");
  lines.push(`## sections (${summary.headings.length})`);
  if (summary.headings.length === 0) lines.push("（无 markdown 标题）");
  for (const h of summary.headings) {
    lines.push(`- L${h.line} [h${h.level}] ${h.text}`);
  }
  lines.push("");
  lines.push(`## key lines (${summary.keyLines.length})`);
  if (summary.keyLines.length === 0) lines.push("（无错误类关键行）");
  for (const k of summary.keyLines) {
    lines.push(`- L${k.line}: ${k.text}`);
  }
  lines.push("");
  lines.push(`## slices (${summary.slices.length})`);
  for (const s of summary.slices) {
    lines.push(
      `- #${String(s.index).padStart(2, "0")} L${s.startLine}-${s.endLine} ` +
        `C${s.startChar}-${s.endChar} fnv=${s.fnv} "${s.preview}"`,
    );
  }
  return lines.join("\n");
}

/**
 * output-compress 事件钩子。
 * 生命周期：attach 订阅 session/event；detach 反订阅（幂等）。
 */
export class OutputCompressHooks {
  /** 宿主事件回调句柄（detach 用）。 */
  private detachFn: (() => void) | null = null;
  /** 已处理事件（session:id/seq）去重表。 */
  private processed = new Set<string>();
  /** tool/call 的 callId → toolName 跟踪表（有界）。 */
  private callNames = new Map<string, string>();
  /** 打开失败退避：失败后 N 毫秒内不再重试打开（避免每次事件都试）。 */
  private openBackoffUntil = 0;
  /** 库未挂载事件的退避重试定时器（detach 时全部清理）。 */
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * @param options 压缩策略与依赖（writer/sandbox/logger 均可注入，便于测试）
   */
  constructor(private readonly options: CompressOptions) {}

  /** 订阅 session/event；返回反订阅函数。 */
  attach(host: HookHost): () => void {
    const handle = host.on("session/event", (session, event) => {
      this.handle(session.id, event);
    });
    this.detachFn = typeof handle === "function" ? handle : null;
    return () => this.detach();
  }

  /** 反订阅（幂等）。 */
  detach(): void {
    if (this.detachFn !== null) {
      this.detachFn();
      this.detachFn = null;
    }
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  /**
   * 同步事件入口：tool/call 只记 toolName；tool/result 走异步管线（不阻塞事件循环）。
   */
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

  /**
   * 异步压缩管线（handle 内部以 void 触发）。任何异常不外泄，只记录告警。
   */
  async process(
    sessionId: string,
    event: SessionEventLike,
  ): Promise<CompressOutcome> {
    const data = event.data;
    if (data === undefined) return { status: "none" };
    // 管线整体捕获：任何失败（库未挂载/派生失败/IO 错误）→ skipped，绝不外泄
    try {
      return await this.#runPipeline(sessionId, event, data);
    } catch (error) {
      const reason =
        error instanceof KbNotMountedError
          ? `kb-not-mounted: ${error.message}`
          : `compress-failed: ${String(error)}`;
      // 库未挂载（knowledge-base 尚未建库）：对同一事件退避重试；其他失败直接跳过
      if (error instanceof KbNotMountedError) {
        this.scheduleKbRetry(sessionId, event, 0, reason);
      } else {
        this.options.logger.info(`output-compress 跳过: ${reason}`);
      }
      return { status: "skipped", reason };
    }
  }

  /** 压缩管线主体（process 的 try/catch 之内执行）。 */
  async #runPipeline(
    sessionId: string,
    event: SessionEventLike,
    data: unknown,
    bypassDedupe = false,
  ): Promise<CompressOutcome> {
    // 去重：同一事件（session+seq）只处理一次（宿主可能重放）；重试路径直接放行
    const dedupeKey = `${sessionId}:${event.seq ?? "n"}`;
    if (!bypassDedupe) {
      if (this.processed.has(dedupeKey)) return { status: "none" };
      this.rememberProcessed(dedupeKey);
    }

    // 提取事件内文本（spill 后为 preview+通知，或原始小输出）
    const text = extractText(data);
    if (text.length === 0) return { status: "none" };
    const { reason, notice } = shouldCompress(text, {
      minChars: this.options.minChars,
    });
    if (reason === "none") return { status: "none" };

    // 读取完整输出：spill 通知 → 文件；阈值触发 → 事件文本本身
    let sourceText: string;
    let totalBytes: number;
    let scannedBytes: number;
    let truncated = false;
    let locator: string | null = null;
    let retrievalHint = "";
    if (reason === "spill-notice" && notice !== null) {
      locator = notice.locator;
      retrievalHint = notice.retrievalHint;
      const read = await this.readSpillSource(notice.locator);
      if (read !== null) {
        // spill 文件即宿主保存的完整格式化结果：totalBytes 取文件实际大小，
        // scannedBytes 取本次实际扫描字节（超 maxSourceBytes 时截断）
        sourceText = read.text;
        totalBytes = read.bytes;
        scannedBytes = Buffer.byteLength(read.text, "utf8");
        truncated = read.bytes > this.options.maxSourceBytes;
      } else {
        // spill 文件不可读：退化为事件内文本（preview+通知），记录告警
        this.options.logger.info(
          `output-compress: spill 文件不可读，退化为事件文本: ${locator}`,
        );
        sourceText = text;
        totalBytes = Buffer.byteLength(text, "utf8");
        scannedBytes = totalBytes;
      }
    } else {
      sourceText = text;
      totalBytes = Buffer.byteLength(text, "utf8");
      scannedBytes = totalBytes;
    }

    // 沙箱派生（确定性摘要）
    const summary = await this.options.sandbox.run(sourceText);

    // 渲染摘要记录并写入共享库
    const callId = extractCallId(data);
    const toolName =
      callId !== null ? (this.callNames.get(callId) ?? null) : null;
    const record = renderSummaryRecord({
      sessionId,
      seq: typeof event.seq === "number" ? event.seq : null,
      toolName,
      locator,
      retrievalHint,
      totalBytes,
      scannedBytes,
      truncated,
      summary,
    });
    const putInput: KbPutInput = {
      project:
        typeof this.options.project === "function"
          ? this.options.project()
          : this.options.project,
      title: `output-compress ${toolName ?? "tool"} ${sessionId.slice(0, 8)}#${
        typeof event.seq === "number" ? event.seq : "n"
      }`,
      content: record,
      category: "output-compress",
      target: "output-compress",
      importance: findIsError(data) ? 4 : 2,
      sessionId,
      source: {
        kind: "tool_result",
        label: toolName ?? undefined,
        ref: locator ?? `session:${sessionId}/seq:${event.seq ?? "n"}`,
      },
    };
    const result = this.options.writer.put(putInput);
    this.options.logger.info(
      `output-compress 入库: session=${sessionId.slice(0, 8)} seq=${
        event.seq ?? "n"
      } tool=${toolName ?? "unknown"} bytes=${totalBytes} newChunks=${result.created}`,
    );
    return {
      status: "written",
      chunks: result.created,
      bytes: totalBytes,
      toolName,
    };
  }

  /** 有界记录 callId → toolName（超出上限整体清空，避免无限增长）。 */
  private rememberCallName(callId: string, name: string): void {
    if (this.callNames.size >= CALL_NAMES_CAP) this.callNames.clear();
    this.callNames.set(callId, name);
  }

  /** 有界记录已处理事件（超出上限整体清空；重放窗口足够短）。 */
  private rememberProcessed(key: string): void {
    if (this.processed.size >= PROCESSED_CAP) this.processed.clear();
    this.processed.add(key);
  }

  /**
   * 读取 spill 文件（maxSourceBytes 上限，超限截断）。
   * 失败（不存在/不可读/超上限以外的 IO 错误）返回 null，由调用方退化处理。
   */
  private async readSpillSource(
    locator: string,
  ): Promise<{ text: string; bytes: number } | null> {
    // 打开失败退避窗口内直接放弃（避免每次事件都重试）
    const now = Date.now();
    if (now < this.openBackoffUntil) return null;
    try {
      const buf = await readFile(locator);
      const totalBytes = buf.length;
      const cap = this.options.maxSourceBytes;
      // 超上限：截断前 cap 字节（派生只覆盖截断部分，摘要内显式标注 truncated）
      const scanned = totalBytes > cap ? buf.subarray(0, cap) : buf;
      return { text: scanned.toString("utf8"), bytes: totalBytes };
    } catch {
      // 退避 10s 后允许再次尝试（spill 文件可能稍后才出现，属罕见竞态）
      this.openBackoffUntil = now + 10_000;
      return null;
    }
  }

  /**
   * 库未挂载重试：knowledge-base 异步建库，首个 tool/result 可能早于库文件出现。
   * 对同一事件按 1/2.5/5/10s 退避重试（最多 4 次）；定时器 unref 不阻塞进程退出，
   * detach 时全部清理。重试直接走管线（绕过 dedup，首轮已登记）。
   */
  private scheduleKbRetry(
    sessionId: string,
    event: SessionEventLike,
    attempt: number,
    lastReason: string,
  ): void {
    const delays = this.options.kbRetryDelays ?? [1_000, 2_500, 5_000, 10_000];
    if (attempt >= delays.length) {
      this.options.logger.info(
        `output-compress 多次重试后放弃（库未挂载）: ${lastReason}`,
      );
      return;
    }
    const delay = delays[attempt] ?? 1_000;
    this.options.logger.info(
      `output-compress 库未挂载，${delay}ms 后重试 (${attempt + 1}/${delays.length})`,
    );
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.#runPipeline(sessionId, event, event.data, true).catch(
        (error: unknown) => {
          const reason =
            error instanceof KbNotMountedError
              ? `kb-not-mounted: ${error.message}`
              : `compress-failed: ${String(error)}`;
          this.scheduleKbRetry(sessionId, event, attempt + 1, reason);
        },
      );
    }, delay);
    timer.unref();
    this.retryTimers.add(timer);
  }
}
