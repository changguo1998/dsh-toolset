// app/adapter/notice-history.ts — 宿主 notice 历史原文的数据面（模型侧按需读取）
//
// 背景：宿主把 `source.form:'notice'` 消息以 user-role 消息送进模型上下文并**全量落持久
// 日志**（`<会话目录>/session.v4.jsonl.zstd`）。compaction 按 retainTokens / retainRatio
// 保留近期尾段后，被压出保留尾段的 notice 原文从上下文消失（摘要块未必覆盖），日志里
// 原文仍在。本模块提供只读通道：解压会话持久日志 → 抽取 notice 消息 → 取最近 N 条（可按
// 生产者类别 `source.kind` 过滤），供模型侧工具 `notice_history` 调用（工具见
// notice-history-tool.ts，注册见 main.ts）。
//
// 数据边界（与 output-compress / spill / memory-base 分工）：notice 原文唯一事实源 = 宿主
// 持久日志；本模块**纯按需只读**，不写任何自有库、不做二次落库。文件与读取口径：
//   - `.zstd` 是宿主拼接式多帧 zstd 容器（每次批量追加一个独立帧），须复刻宿主的
//     `scanZstdFrames`（`dsh-session-persistence-jsonl` 的 frame 定位）+ `zstdDecompressSync`
//     逐帧解压；Node ≥23 自带 zstd 支持（`node:zlib.zstdDecompressSync`），无新依赖。
//   - `.zstd` 缺失时回落明文 `session.v4.jsonl`（宿主关闭压缩时的配置）。
//   - 会话目录定位复用 `locateSessionDir`（app/adapter/session-paths.ts：id 白名单 +
//     realpath 包含性校验，恒在 `<DSH_HOME>/sessions` 下，不越权）。
//   - 读取一律 best-effort：尾部撕裂帧跳过、坏帧跳过并计数、坏 JSON 行跳过，绝不抛到工具外。

import { readFileSync } from "node:fs";
import * as zlib from "node:zlib";
import { join } from "node:path";
import { locateSessionDir, sessionRoots } from "./session-paths.ts";

/** 主日志文件名（会话目录内；同目录还有 session.lock / tui-state.json / tui-local.jsonl） */
export const SESSION_LOG_ZSTD_FILE = "session.v4.jsonl.zstd";
/** 明文回落文件名（宿主关闭 zstd 压缩时） */
export const SESSION_LOG_PLAIN_FILE = "session.v4.jsonl";
/** 读取条数缺省 / 上限（对齐 tui_local_log） */
export const NOTICE_DEFAULT_LIMIT = 20;
export const NOTICE_MAX_LIMIT = 200;

/** 一条 notice 记录（从持久日志事件抽取后的归一形态） */
export interface NoticeEntry {
  /** 消息 id（`user/message` 与 `agent/inbox/spliced.inserted` 同 id 双现，据此去重） */
  id: string;
  /** 生产者类别（`source.kind`，如 tool-jobs / subagent-settled / model-selection） */
  kind: string;
  /** 展示用一行摘要（`source.summary`，宿主 notice 必有，可缺） */
  summary?: string;
  /** 原文（`content` 各 text 块拼接；即 compaction 后从上下文消失的部分） */
  content: string;
  /** 事件时间戳（epoch ms，取承载事件的 `time`） */
  ts: number;
  /** 事件序号（log 内的单调序号，用于保持原始顺序） */
  seq: number;
}

/** 读取参数 */
export interface NoticeReadOptions {
  /** 只按生产者类别看某类（`source.kind` 精确匹配；缺省不过滤） */
  kind?: string;
  /** 取最近 N 条（缺省 NOTICE_DEFAULT_LIMIT，上限 NOTICE_MAX_LIMIT） */
  limit?: number;
}

/** 读取结果：ok=false 时 error 为明确报错（会话非法 / 目录未定位）；ok=true 时可能为空 */
export interface NoticeQueryResult {
  ok: boolean;
  /** 实际返回条数（ok=false 时为 0） */
  count: number;
  entries: NoticeEntry[];
  /** 错误原因（ok=false 时）或「空结果说明」 */
  error?: string;
  /** 跳过帧 / 坏行计数（诊断用） */
  skipped?: { frames: number; lines: number };
}

/** 会话 id 白名单（复用 session-paths 的判定，与 tui_local_log 同口径） */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528

/**
 * 复刻宿主 `scanZstdFrames`（dsh-session-persistence-jsonl）：按帧头 + 块结构定位完整帧
 * 的字节区间，不做解压。返回 `{ frames, tornStart? }`——`tornStart` 非空表示文件末尾有
 * 未写完的帧（会话运行中正常现象），调用方跳过即可。
 */
export function scanZstdFrames(buffer: Uint8Array): {
  frames: Array<[number, number]>;
  tornStart: number | undefined;
} {
  const frames: Array<[number, number]> = [];
  const length = buffer.length;
  let offset = 0;
  const stopTorn = (
    start: number,
  ): { frames: Array<[number, number]>; tornStart: number | undefined } => {
    // 已解析出的完整帧保留；从 start 起的剩余字节不可继续解析（未写完 / 结构非法）。
    return { frames, tornStart: start };
  };
  while (offset < length) {
    const start = offset;
    if (length - offset < 4) return stopTorn(start);
    // 帧魔数 ZSTD_MAGIC=0xFD2FB528（LE 字节 28 B5 2F FD）；不符 → 非本容器可解析内容，停止
    if (
      buffer[offset] !== 0x28 ||
      buffer[offset + 1] !== 0xb5 ||
      buffer[offset + 2] !== 0x2f ||
      buffer[offset + 3] !== 0xfd
    ) {
      return stopTorn(start);
    }
    offset += 4;
    if (offset === length) return stopTorn(start);
    // 帧头描述字节：bit0-1 字典、bit2 校验、bit5 单段、bit6-7 内容尺寸标志
    const descriptor = buffer[offset]!;
    offset += 1;
    if ((descriptor & 24) !== 0) return stopTorn(start); // bit3-4 保留位置位 → 结构非法，停止
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (length - offset < remainingHeaderBytes) return stopTorn(start);
    offset += remainingHeaderBytes;
    for (;;) {
      if (length - offset < 3) return stopTorn(start);
      const blockHeader =
        (buffer[offset]! as number) |
        ((buffer[offset + 1]! as number) << 8) |
        ((buffer[offset + 2]! as number) << 16);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return stopTorn(start); // 保留块类型
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (length - offset < payloadBytes) return stopTorn(start);
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (length - offset < 4) return stopTorn(start);
      offset += 4;
    }
    frames.push([start, offset]);
  }
  return { frames, tornStart: undefined };
}

/**
 * 解压会话日志字节 → 文本。逐帧解压（宿主同法）；zstd 能力缺失（Node <23 构建不带）
 * → 抛错由调用方转明确错误；坏帧跳过并计数，不中断整份读取。
 */
export function decodeSessionLogText(
  buffer: Uint8Array,
  log: { skippedFrames: () => void } = { skippedFrames: () => {} },
): string {
  const decompress = (
    zlib as unknown as { zstdDecompressSync?: (b: Uint8Array) => Buffer }
  ).zstdDecompressSync;
  if (typeof decompress !== "function") {
    throw new Error(
      "当前 Node 构建的 node:zlib 不含 zstd 支持（需 Node ≥23），无法解压 session.v4.jsonl.zstd",
    );
  }
  const { frames } = scanZstdFrames(buffer);
  const parts: Buffer[] = [];
  for (const [start, end] of frames) {
    try {
      parts.push(decompress(buffer.subarray(start, end)));
    } catch {
      log.skippedFrames(); // 单帧损坏 → 跳过，不中断
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

/** 从一个事件的 `content` 块数组提取纯文本（仅 text 块；空/非 text 忽略） */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
  }
  return texts.join("");
}

/**
 * 从整份日志文本抽取 notice 记录（原始 log 顺序）。
 * 判别：`source.form === 'notice'`。来源两类：
 *   - `user/message` 事件（`data` 即 UserMessage，`source.form` 判别）；
 *   - `agent/inbox/spliced` 事件（`data.inserted[]` 内含完整消息，同判别）。
 * 同一 notice 会在两类事件里**同 id 双现**（实测），按消息 id 去重（保留先出现的条目，
 * 两处 content 相同；时间戳取承载事件 time，去重对象是后出现的副本）。
 * 坏 JSON 行与形状不符行跳过并计数。
 */
export function parseNoticeEntries(
  text: string,
  log: { skippedLines: () => void } = { skippedLines: () => {} },
): NoticeEntry[] {
  const entries: NoticeEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: NoticeEntry): void => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(entry);
  };
  for (const line of text.split("\n")) {
    if (!line.includes("notice")) continue; // 绝大多数行与 notice 无关，快速跳过
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      log.skippedLines();
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    const e = event as Record<string, unknown>;
    const type = e.type;
    const seq = typeof e.seq === "number" ? e.seq : 0;
    const ts = typeof e.time === "number" ? e.time : 0;
    const data = e.data as Record<string, unknown> | null | undefined;
    if (data === null || typeof data !== "object") continue;
    if (type === "user/message") {
      const source = data.source as Record<string, unknown> | null | undefined;
      if (
        source === null ||
        typeof source !== "object" ||
        source.form !== "notice"
      )
        continue;
      const id =
        typeof data.id === "string" && data.id !== "" ? data.id : `${seq}`;
      const kind = typeof source.kind === "string" ? source.kind : "";
      const summary =
        typeof source.summary === "string" ? source.summary : undefined;
      push({
        id,
        kind,
        ...(summary === undefined ? {} : { summary }),
        content: contentText(data.content),
        ts,
        seq,
      });
      continue;
    }
    if (type === "agent/inbox/spliced") {
      const inserted = data.inserted;
      if (!Array.isArray(inserted)) continue;
      for (const item of inserted) {
        if (item === null || typeof item !== "object") continue;
        const m = item as Record<string, unknown>;
        const source = m.source as Record<string, unknown> | null | undefined;
        if (
          source === null ||
          typeof source !== "object" ||
          source.form !== "notice"
        )
          continue;
        const id = typeof m.id === "string" && m.id !== "" ? m.id : `${seq}`;
        const kind = typeof source.kind === "string" ? source.kind : "";
        const summary =
          typeof source.summary === "string" ? source.summary : undefined;
        push({
          id,
          kind,
          ...(summary === undefined ? {} : { summary }),
          content: contentText(m.content),
          ts,
          seq,
        });
      }
    }
  }
  return entries;
}

/** 解析会话目录（复用 session-paths：id 白名单 + realpath 包含性校验）；失败给明确原因 */
function resolveSessionDir(
  sessionId: string,
  roots: readonly string[],
): { ok: true; dir: string } | { ok: false; error: string } {
  if (!isValidSessionId(sessionId)) {
    return { ok: false, error: `会话 id 非法：${sessionId}` };
  }
  const found = locateSessionDir(sessionId, roots);
  if (!found.ok) {
    return {
      ok: false,
      error: `会话「${sessionId}」的持久化目录未找到（${found.reason}）`,
    };
  }
  return { ok: true, dir: found.path };
}

/**
 * 读取某会话的 notice 历史（最近 N 条，按 log 顺序返回；可按生产者类别过滤）。
 * 错误语义：会话 id 非法 / 目录未定位 → ok=false + 明确 error；日志文件缺失 → ok=true
 * + 空 entries + error 说明（有效会话尚未落盘或全无 notice，不算错误）。
 * @param sessionId - 目标会话 id
 * @param opts - kind 过滤与条数
 * @param roots - 会话根（缺省 sessionRoots()；测试注入临时根）
 */
export function readNoticeHistory(
  sessionId: string,
  opts: NoticeReadOptions = {},
  roots: readonly string[] = sessionRoots(),
): NoticeQueryResult {
  const resolved = resolveSessionDir(sessionId, roots);
  if (!resolved.ok)
    return { ok: false, count: 0, entries: [], error: resolved.error };
  const { dir } = resolved;
  const kind = opts.kind;
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? NOTICE_DEFAULT_LIMIT)),
    NOTICE_MAX_LIMIT,
  );

  // 读日志：优先 zstd 多帧文件，缺失回落明文（两个都缺 → 视为「尚无 notice 日志」）。
  const skipped = { frames: 0, lines: 0 };
  let text: string;
  let zstdBuf: Buffer | undefined;
  try {
    zstdBuf = readFileSync(join(dir, SESSION_LOG_ZSTD_FILE));
  } catch {
    zstdBuf = undefined;
  }
  if (zstdBuf !== undefined) {
    try {
      text = decodeSessionLogText(zstdBuf, {
        skippedFrames: () => {
          skipped.frames += 1;
        },
      });
    } catch (error) {
      return {
        ok: false,
        count: 0,
        entries: [],
        error: `解压会话「${sessionId}」持久日志失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    try {
      text = readFileSync(join(dir, SESSION_LOG_PLAIN_FILE), "utf8");
    } catch {
      return {
        ok: true,
        count: 0,
        entries: [],
        error: `会话「${sessionId}」尚无 notice 持久日志（${SESSION_LOG_ZSTD_FILE} 与 ${SESSION_LOG_PLAIN_FILE} 均缺失；可能尚未落盘）`,
      };
    }
  }

  let all = parseNoticeEntries(text, {
    skippedLines: () => {
      skipped.lines += 1;
    },
  });
  if (kind !== undefined && kind !== "") {
    all = all.filter((entry) => entry.kind === kind);
  }
  const entries = all.slice(-limit);
  const skippedInfo =
    skipped.frames > 0 || skipped.lines > 0
      ? { frames: skipped.frames, lines: skipped.lines }
      : undefined;
  return {
    ok: true,
    count: entries.length,
    entries,
    ...(skippedInfo === undefined ? {} : { skipped: skippedInfo }),
  };
}
