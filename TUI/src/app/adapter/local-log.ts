// app/adapter/local-log.ts — TUI 本地输出旁路日志（模型侧按需读取）
//
// 背景：TUI 有一批「只给用户看」的输出——`$` 模式的命令与结果、App 自造的命令提示
// （notice）等，按设计不经 adapter、不进模型上下文（见 index.ts 的 runLocalShell /
// notice）。它们按会话追加到会话目录旁的 `<会话目录>/tui-local.jsonl`，由模型侧工具
// `tui_local_log` 读取（注册见 main.ts）。与 tui-state.json 同族：
//  - 随会话目录删除一起清理（deleteSessionDir 删的是整个目录）；
//  - 读写一律 best-effort：目录不存在 / 不可写 / 文件损坏都静默降级，绝不影响渲染。
//
// 文件形态：每行一条 JSON（JSONL）：
//   {"ts":1792383378007,"kind":"shell","text":"$ ls\n...","meta":{"command":"ls","exitCode":0,"ms":12}}
// 上限：单文件 maxBytes（缺省 256 KB，写满后把旧文件轮转为 `tui-local.jsonl.1` 再续写）；
// 单条 text 截到 maxTextChars（缺省 8 KB）。读取只读主文件（轮转文件留给人工排查）。

import { readFileSync } from "node:fs";
import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { locateSessionDir, sessionRoots } from "./session-paths.ts";

/** 主文件名（会话目录内；同目录还有宿主的 session.v4.jsonl.zstd / session.lock / tui-state.json） */
export const LOCAL_LOG_FILE = "tui-local.jsonl";
/** 轮转文件名（写满后旧内容整体改名到这里，覆盖上一份） */
export const LOCAL_LOG_ROTATED_FILE = "tui-local.jsonl.1";
/** 单文件上限缺省（字节） */
export const LOCAL_LOG_MAX_BYTES = 256 * 1024;
/** 单条 text 上限缺省（字符） */
export const LOCAL_LOG_MAX_TEXT_CHARS = 8 * 1024;
/** 读取条数缺省 / 上限 */
export const LOCAL_LOG_DEFAULT_LIMIT = 20;
export const LOCAL_LOG_MAX_LIMIT = 200;

/** 条目类别：`shell` = `$` 模式（命令回显 / 结果 / guard 拦截），`notice` = App 自造提示 */
export type LocalLogKind = "shell" | "notice";

/** 一条本地输出（写入与读取共用） */
export interface LocalLogEntry {
  /** 写入时刻（epoch ms） */
  ts: number;
  kind: LocalLogKind;
  /** 正文（多行原样；写入时按 maxTextChars 截断） */
  text: string;
  /** 附加信息（`shell`：command / exitCode / ms / timedOut） */
  meta?: Record<string, unknown>;
}

/** 写入参数（main.ts 从 tui.config.json 的 localLog 段归一化后传入） */
export interface LocalLogWriteOptions {
  enabled: boolean;
  maxBytes: number;
  maxTextChars: number;
  /** 会话根（缺省 sessionRoots()；测试注入临时根） */
  roots?: readonly string[];
}

/** 读取参数 */
export interface LocalLogReadOptions {
  /** 只看某类（缺省 all） */
  kind?: LocalLogKind | "all";
  /** 取最近 N 条（缺省 LOCAL_LOG_DEFAULT_LIMIT，上限 LOCAL_LOG_MAX_LIMIT） */
  limit?: number;
}

/** 会话目录命中缓存（写入高频，避免每条都 readdir + realpath）。
 *  只缓存**命中**：新会话在宿主落盘前定位失败，缓存未命中会让它此后永远写不进去。 */
const dirCache = new Map<string, string>();

/**
 * 解析会话目录（带命中缓存）。
 * @param id - 会话 id
 * @param roots - 会话根（缺省 sessionRoots()）
 * @returns 会话目录的 realpath；未持久化 / 非法 id → undefined
 */
export function localLogDir(
  id: string,
  roots: readonly string[] = sessionRoots(),
): string | undefined {
  const cached = dirCache.get(id);
  if (cached !== undefined) return cached;
  const found = locateSessionDir(id, roots);
  if (!found.ok) return undefined;
  dirCache.set(id, found.path);
  return found.path;
}

/** 清会话目录缓存（测试与「会话目录被外部删除」后重试用） */
export function clearLocalLogDirCache(): void {
  dirCache.clear();
}

/** 截断单条正文（超限补标记，保留原文前段） */
function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…（已截断）";
}

/** 一条 entry → 单行 JSON；空正文返回 undefined（不落空条目） */
export function serializeLocalLogEntry(
  entry: LocalLogEntry,
  maxTextChars: number = LOCAL_LOG_MAX_TEXT_CHARS,
): string | undefined {
  const text = entry.text;
  if (text.trim() === "") return undefined;
  const capped: LocalLogEntry = {
    ts: entry.ts,
    kind: entry.kind,
    text: capText(text, maxTextChars),
    ...(entry.meta === undefined ? {} : { meta: entry.meta }),
  };
  return JSON.stringify(capped);
}

/** 解析一行 JSON（坏行 / 形状不符 → undefined，调用方跳过） */
export function parseLocalLogLine(line: string): LocalLogEntry | undefined {
  const raw = line.trim();
  if (raw === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const ts =
    typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : undefined;
  const kind = o.kind === "shell" || o.kind === "notice" ? o.kind : undefined;
  const text = typeof o.text === "string" ? o.text : undefined;
  if (ts === undefined || kind === undefined || text === undefined)
    return undefined;
  const meta =
    o.meta !== null && typeof o.meta === "object" && !Array.isArray(o.meta)
      ? (o.meta as Record<string, unknown>)
      : undefined;
  return { ts, kind, text, ...(meta === undefined ? {} : { meta }) };
}

/** 写入串行链：同一进程内多次追加按调用顺序排队，避免交错写坏行 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * 追加一条本地输出（**fire-and-forget**：不返回结果、不抛错，调用方不 await）。
 * 关闭（enabled=false）/ 无会话 / 会话未持久化 / 空正文 → 直接丢弃。
 * @param sessionId - 归属会话 id（App 的 state.activeSessionId）
 * @param entry - 条目（ts 由调用方或本函数补齐）
 * @param opts - 开关与上限
 * @param roots - 会话根（缺省 sessionRoots()；测试注入临时根用）
 */
export function appendLocalLog(
  sessionId: string | undefined,
  entry: LocalLogEntry,
  opts: LocalLogWriteOptions,
  roots: readonly string[] = opts.roots ?? sessionRoots(),
): void {
  if (!opts.enabled || sessionId === undefined || sessionId === "") return;
  const dir = localLogDir(sessionId, roots);
  if (dir === undefined) return;
  const line = serializeLocalLogEntry(entry, opts.maxTextChars);
  if (line === undefined) return;
  const payload = line + "\n";
  writeChain = writeChain
    .then(() => writeLine(dir, payload, opts.maxBytes))
    .catch(() => {
      /* best-effort：磁盘满 / 目录被删 / 权限变化一律静默 */
    });
}

/** 单次落盘：超过上限先把旧文件轮转，再追加（轮转失败则继续往大文件追加，不丢新条目） */
async function writeLine(
  dir: string,
  payload: string,
  maxBytes: number,
): Promise<void> {
  const target = join(dir, LOCAL_LOG_FILE);
  let size = 0;
  try {
    size = (await stat(target)).size;
  } catch {
    size = 0; // 首次写入
  }
  if (size > 0 && size + Buffer.byteLength(payload) > maxBytes) {
    try {
      await rename(target, join(dir, LOCAL_LOG_ROTATED_FILE));
    } catch {
      /* 轮转失败（并发删除等）→ 照旧追加 */
    }
  }
  await appendFile(target, payload, "utf8");
}

/**
 * 读取本地输出（最近 N 条，按时间正序返回）。文件缺失 / 损坏行 → 跳过。
 * @param sessionId - 会话 id
 * @param opts - 类别过滤与条数
 * @param roots - 会话根（缺省 sessionRoots()）
 * @returns 条目数组（无数据 → 空数组）
 */
export function readLocalLog(
  sessionId: string,
  opts: LocalLogReadOptions = {},
  roots: readonly string[] = sessionRoots(),
): LocalLogEntry[] {
  const dir = localLogDir(sessionId, roots);
  if (dir === undefined) return [];
  let raw: string;
  try {
    raw = readFileSync(join(dir, LOCAL_LOG_FILE), "utf8");
  } catch {
    return [];
  }
  const kind = opts.kind ?? "all";
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? LOCAL_LOG_DEFAULT_LIMIT)),
    LOCAL_LOG_MAX_LIMIT,
  );
  const entries: LocalLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const parsed = parseLocalLogLine(line);
    if (parsed === undefined) continue;
    if (kind !== "all" && parsed.kind !== kind) continue;
    entries.push(parsed);
  }
  return entries.slice(-limit);
}
