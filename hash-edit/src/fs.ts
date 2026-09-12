/**
 * fs：文件级锚定编辑（本包唯一 IO 层，node:fs/promises 薄封装）。
 *
 * DSH 宿主内本层职责与 tool-fs 的文件读写底座重合，宿主侧可由 tool-fs 承接；
 * 包内为独立可测/可 demo，直接用标准库 IO，不新增运行时依赖。
 * 行级锚定与 fs-observation-policy 的版本号守护互补：本层以「读取快照锚点」
 * 判定 staleness，拒绝发生在任何写操作之前，失败时文件字节不变（无半写）。
 * 成功路径为同目录临时文件 + rename 原子替换，保留原文件权限位。
 */

import {
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type EditOp, type EditSuccess, applyAnchoredEdits } from "./edit.ts";
import { type Hashline, fileHash, hashlines } from "./hashline.ts";

/** 文件级错误码：文件不存在 / 非 UTF-8 / IO 失败。 */
export type FileErrorCode = "not_found" | "not_utf8" | "io_error";

/** 文件级错误（IO 类；锚定校验类错误见 edit.ts 的 AnchoredEditError）。 */
export class FileEditError extends Error {
  constructor(
    public readonly code: FileErrorCode,
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "FileEditError";
  }
}

/** 读取结果：文件哈希（全量核对用）+ 指定窗口内的行锚点列表。 */
export interface ReadResult {
  ok: true;
  path: string;
  file_hash: string;
  line_count: number;
  hashlines: Hashline[];
}

/** 严格 UTF-8 解码（非法字节序列抛异常，拒绝二进制文件，对照 readseek 行为）。 */
function decodeUtf8Strict(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}

/** 相对路径以 root（缺省宿主 cwd）为基准解析。 */
function resolvePath(filePath: string, root?: string): string {
  return isAbsolute(filePath)
    ? filePath
    : resolve(root ?? process.cwd(), filePath);
}

/**
 * 读取文件的行锚点（hash_read 后端）：
 * offset/limit 为 1 基行窗口（limit 缺省 200），返回窗口内的 LINE:HASH 列表与全文哈希。
 */
export async function readHashlines(
  filePath: string,
  root?: string,
  offset = 1,
  limit = 200,
): Promise<ReadResult> {
  const p = resolvePath(filePath, root);
  let buf: Buffer;
  try {
    buf = await readFile(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new FileEditError("not_found", `file not found: ${p}`, p);
    }
    throw new FileEditError("io_error", `read failed: ${String(err)}`, p);
  }
  let content: string;
  try {
    content = decodeUtf8Strict(buf);
  } catch {
    throw new FileEditError("not_utf8", `file is not valid UTF-8: ${p}`, p);
  }
  const all = hashlines(content);
  const start = Math.max(0, offset - 1);
  return {
    ok: true,
    path: p,
    file_hash: fileHash(content),
    line_count: all.length,
    hashlines: all.slice(start, start + limit),
  };
}

/** 文件级锚定编辑结果：成功载荷 + 目标文件绝对路径。 */
export type FileEditSuccess = EditSuccess & { path: string };

/**
 * 文件级锚定编辑（hash_edit 后端）：
 * 读文件 → 纯函数校验+应用（任一锚点 stale/越界/重叠 → 抛 AnchoredEditError，文件不变）
 * → 同目录临时文件 + rename 原子替换（保留原文件权限）。
 */
export async function applyAnchoredEditsFile(
  filePath: string,
  edits: readonly EditOp[],
  root?: string,
): Promise<FileEditSuccess> {
  const p = resolvePath(filePath, root);
  let buf: Buffer;
  try {
    buf = await readFile(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new FileEditError("not_found", `file not found: ${p}`, p);
    }
    throw new FileEditError("io_error", `read failed: ${String(err)}`, p);
  }
  let content: string;
  try {
    content = decodeUtf8Strict(buf);
  } catch {
    throw new FileEditError("not_utf8", `file is not valid UTF-8: ${p}`, p);
  }

  // 校验与应用（纯函数）：失败时直接抛出，不产生任何写操作
  const result = applyAnchoredEdits(content, edits);

  // 原子写：同目录临时文件 + rename；mode 保留原文件权限位
  let mode: number;
  try {
    mode = (await stat(p)).mode & 0o7777;
  } catch (err) {
    throw new FileEditError("io_error", `stat failed: ${String(err)}`, p);
  }
  const tmp = join(dirname(p), `.${basename(p)}.hashedit-${process.pid}.tmp`);
  try {
    await writeFile(tmp, result.content, { encoding: "utf8", mode });
    await rename(tmp, p);
  } catch (err) {
    // 清理残留临时文件（rename 成功则已不存在，忽略清理失败）
    try {
      await removeQuietly(tmp);
    } catch {
      // 忽略清理失败
    }
    throw new FileEditError("io_error", `write failed: ${String(err)}`, p);
  }
  return { ...result, path: p };
}

/** 安静删除（不存在即视为成功；清理失败不掩盖原始错误）。 */
async function removeQuietly(p: string): Promise<void> {
  await rm(p, { force: true }).catch(() => undefined);
}

/** 列出目录条目名（供测试断言无临时文件残留）。 */
export async function listDir(p: string): Promise<string[]> {
  return readdir(p);
}
