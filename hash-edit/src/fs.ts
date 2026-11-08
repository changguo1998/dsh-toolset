/**
 * fs：文件级锚定编辑（本包唯一 IO 层; 读写只经 `HashFileIo`）。
 *
 * 读写面由 io 决定：插件侧是 `ctx.fs`（围栏 / 版本守卫 / 原子写由宿主后端保证），
 * 库面缺省是 node 标准库实现。行级锚定与后端文件级版本守卫**互补**：本层以「读取快照锚点」
 * 判定 staleness（行粒度，先于任何写），后端以整文件版本令牌挡「读后被外部改动」；
 * 两者任一不成立都拒绝，失败时文件字节不变（无半写）。
 */

import { type EditOp, type EditSuccess, applyAnchoredEdits } from "./edit.ts";
import { type Hashline, fileHash, hashlines } from "./hashline.ts";
import {
  HashFileError,
  nodeHashFileIo,
  type HashFileIo,
  type HashFileTarget,
} from "./io.ts";

/** 文件级错误码：文件不存在 / 非 UTF-8 / IO 失败 / 读后被改动 / 围栏拒绝。 */
export type FileErrorCode =
  "not_found" | "not_utf8" | "io_error" | "stale" | "sandbox_denied";

/** 文件级错误（IO 类；锚定校验类错误见 `hash-edit/src/edit.ts` 的 AnchoredEditError）。 */
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
  /** 读取时的文件版本令牌（内部用; 工具面不返回它, 供后续写入做基准）。 */
  version: string;
}

/** 读写选项：文件读写面与相对路径基准。 */
export interface FileIoOptions {
  /** 文件读写面; 缺省用 `nodeHashFileIo()`（库面 / demo / 单测）。 */
  io?: HashFileIo;
  /** 相对路径基准; 缺省交给 io 自己的基准（插件侧是会话目录）。 */
  cwd?: string;
}

/** 读取选项：读写面 + 行窗口（1 基 offset、limit 缺省 200）。 */
export interface ReadOptions extends FileIoOptions {
  offset?: number;
  limit?: number;
}

/**
 * 后端错误到本包错误码的映射（唯一一处）:
 * 不存在 / 非文本 / 版本过期 / 围栏拒绝各自成码, 其余归 `io_error` 并保留原始 message。
 */
function toFileError(
  error: unknown,
  path: string,
  phase: "read" | "write",
): FileEditError {
  if (error instanceof HashFileError) {
    switch (error.code) {
      case "FS_NOT_FOUND":
        return new FileEditError("not_found", `file not found: ${path}`, path);
      case "FS_NOT_TEXT":
        return new FileEditError(
          "not_utf8",
          `file is not valid UTF-8: ${path}`,
          path,
        );
      case "FS_STALE_VERSION":
        return new FileEditError(
          "stale",
          `file changed since read: ${path} (re-run hash_read)`,
          path,
        );
      case "FS_SANDBOX_DENIED":
        return new FileEditError("sandbox_denied", error.message, path);
      default:
        return new FileEditError(
          "io_error",
          `${phase} failed: ${error.message}`,
          path,
        );
    }
  }
  return new FileEditError(
    "io_error",
    `${phase} failed: ${String(error)}`,
    path,
  );
}

/** 解析目标（相对路径按 `cwd` / io 自己的基准）。 */
async function resolveTarget(
  io: HashFileIo,
  filePath: string,
  cwd: string | undefined,
): Promise<HashFileTarget> {
  try {
    return await io.resolve(filePath, cwd === undefined ? {} : { cwd });
  } catch (error) {
    throw toFileError(error, filePath, "read");
  }
}

/** 读元信息 + 全文（不存在 / 非常规文件 / 非 UTF-8 都在这里拒）。 */
async function loadText(
  io: HashFileIo,
  target: HashFileTarget,
): Promise<{ text: string; version: string }> {
  let info;
  try {
    info = await io.stat(target);
  } catch (error) {
    throw toFileError(error, target.displayPath, "read");
  }
  if (info === undefined) {
    throw new FileEditError(
      "not_found",
      `file not found: ${target.displayPath}`,
      target.displayPath,
    );
  }
  if (info.type !== "file") {
    throw new FileEditError(
      "io_error",
      `read failed: not a regular file: ${target.displayPath}`,
      target.displayPath,
    );
  }
  try {
    return {
      text: await io.readText(target),
      version: info.version,
    };
  } catch (error) {
    throw toFileError(error, target.displayPath, "read");
  }
}

/**
 * 读取文件的行锚点（hash_read 后端）：
 * offset/limit 为 1 基行窗口（limit 缺省 200），返回窗口内的 LINE:HASH 列表与全文哈希。
 */
export async function readHashlines(
  filePath: string,
  options: ReadOptions = {},
): Promise<ReadResult> {
  const io = options.io ?? nodeHashFileIo();
  const target = await resolveTarget(io, filePath, options.cwd);
  const { text, version } = await loadText(io, target);
  const all = hashlines(text);
  const start = Math.max(0, (options.offset ?? 1) - 1);
  return {
    ok: true,
    path: target.displayPath,
    file_hash: fileHash(text),
    line_count: all.length,
    hashlines: all.slice(start, start + (options.limit ?? 200)),
    version,
  };
}

/** 文件级锚定编辑结果：成功载荷 + 目标文件绝对路径。 */
export type FileEditSuccess = EditSuccess & { path: string };

/**
 * 文件级锚定编辑（hash_edit 后端）：
 * 读文件 → 纯函数校验+应用（任一锚点 stale/越界/重叠 → 抛 AnchoredEditError，文件不变）
 * → `io.writeText` 带读到的版本写回（读后被外部改动时后端拒绝, 对外 `stale`）。
 */
export async function applyAnchoredEditsFile(
  filePath: string,
  edits: readonly EditOp[],
  options: FileIoOptions = {},
): Promise<FileEditSuccess> {
  const io = options.io ?? nodeHashFileIo();
  const target = await resolveTarget(io, filePath, options.cwd);
  const { text, version } = await loadText(io, target);

  // 校验与应用（纯函数）：失败时直接抛出，不产生任何写操作
  const result = applyAnchoredEdits(text, edits);

  try {
    await io.writeText(target, result.content, {
      kind: "replaceIfVersion",
      version,
    });
  } catch (error) {
    throw toFileError(error, target.displayPath, "write");
  }
  return { ...result, path: target.displayPath };
}

/** 列出目录条目名（供测试断言无临时文件残留）。 */
export async function listDir(p: string, io?: HashFileIo): Promise<string[]> {
  const files = io ?? nodeHashFileIo();
  let target: HashFileTarget;
  try {
    target = await files.resolve(p);
  } catch (error) {
    throw toFileError(error, p, "read");
  }
  try {
    const entries = await files.listDir(target);
    return entries.map((entry) => entry.name);
  } catch (error) {
    throw toFileError(error, p, "read");
  }
}
