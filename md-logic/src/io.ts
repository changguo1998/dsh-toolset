/**
 * 文件读写适配：接口 + `node:fs` 缺省实现（项目级追踪文档的 D2 / D3）。
 *
 * 本包只经 `MdFileIo` 碰用户文件：
 * - 插件侧注入 `ctx.fs` 实现（`md-logic/src/ctx-fs-io.ts`）：解析走 `ctx.fs.resolve`,
 *   读走 `stat` / `readText`, 写走 `ctx.fs.writeText` + 写意图瀑布 + 会话沙箱策略;
 * - 库面、示例与单测缺省用 `nodeMdFileIo()`, 行为与改造前的直读直写等价;
 * - 错误统一成 `MdFileError`: `code` 沿用官方 `FsError` 码, 对外统一由 `edit.ts` 映射成本包的
 *   `EditFailureCode`（`read_failed` / `not_utf8` / `file_changed` / `write_failed`）。
 *
 * 成员名与宿主 `FileSystem` 对齐（`resolve` / `stat` / `readText` / `writeText`）;
 * 本包没有子进程, 故不需要 `processPath`。
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** 解析后的文件目标（宿主 `FsTarget` 的同形子集）。 */
export interface MdFileTarget {
  /** 后端内部标识（本地后端是规范化路径）; 本包不解析它。 */
  readonly targetKey: string;
  /** 模型 / 界面可见路径。 */
  readonly displayPath: string;
}

/** 解析选项（宿主 `FileSystem.resolve` 的同形子集）。 */
export interface MdResolveOptions {
  /** 相对路径基准目录; 缺省由后端决定。 */
  readonly cwd?: string;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 目标元信息（宿主 `FsInfo` 的同形子集）。 */
export interface MdFileInfo {
  /** 当前版本令牌; 写入时作为 `replaceIfVersion` 的基准。 */
  readonly version: string;
  /** 目标类型。 */
  readonly type: "file" | "directory" | "other";
  /** 普通文件的字节大小（`maxBytes` 上限用它判）。 */
  readonly size?: number;
}

/** 写入意图（宿主 `FsWriteIntent` 的同形子集）。 */
export type MdWriteIntent =
  | { readonly kind: "createIfAbsent" }
  | { readonly kind: "replaceIfVersion"; readonly version: string };

/** 写入结果（宿主 `FsWriteOutcome` 的同形子集）。 */
export interface MdWriteOutcome {
  /** 写入后的版本令牌。 */
  readonly version: string;
}

/**
 * 文件读写面：本包唯一的文件入口。
 * 两个实现见 `nodeMdFileIo`（库面缺省）与 `ctxMdFileIo`（插件侧, 走官方围栏）。
 */
export interface MdFileIo {
  /** 把模型给的路径解析成稳定目标。 */
  resolve(path: string, opts?: MdResolveOptions): Promise<MdFileTarget>;
  /** 读元信息; 目标不存在时为 `undefined`。 */
  stat(
    target: MdFileTarget,
    signal?: AbortSignal,
  ): Promise<MdFileInfo | undefined>;
  /** 读整段 UTF-8 文本（逐字节, 不做换行归一）。 */
  readText(target: MdFileTarget, signal?: AbortSignal): Promise<string>;
  /** 原子写整段 UTF-8 文本; `intent` 缺省即无条件覆盖。 */
  writeText(
    target: MdFileTarget,
    text: string,
    intent?: MdWriteIntent,
    signal?: AbortSignal,
  ): Promise<MdWriteOutcome>;
}

/**
 * 本包错误的码表: 前九个沿用官方 `FsError` 码（便于与宿主对拍）,
 * 末一个是本包自有的「宿主没挂 `ctx.fs`」——宿主没有对应码, 单列以区分「服务缺失」与「读写失败」。
 */
export type MdFileErrorCode =
  | "FS_NOT_FOUND"
  | "FS_NOT_TEXT"
  | "FS_NOT_REGULAR_FILE"
  | "FS_STALE_VERSION"
  | "FS_NOT_OBSERVED"
  | "FS_SANDBOX_DENIED"
  | "FS_PERMISSION_DENIED"
  | "FS_IO_ERROR"
  | "FS_ABORTED"
  | "FS_UNAVAILABLE";

/**
 * 错误码到详情文案的映射（对外措辞由 `edit.ts` 按 `EditFailureCode` 再包一层）:
 * `FS_SANDBOX_DENIED` 与 `FS_UNAVAILABLE` 原样透出——前者自带 `[sandbox: …]` 标记与升档指引,
 * 后者本身就是可行动说明; 其余码给一句中文前缀, 原始 message 留在括号里。
 */
export function mdFileErrorText(code: MdFileErrorCode, detail: string): string {
  switch (code) {
    case "FS_NOT_FOUND":
      return `文件不存在（${detail}）`;
    case "FS_NOT_TEXT":
      return `目标不是合法 UTF-8 文本（疑似二进制, ${detail}）`;
    case "FS_NOT_REGULAR_FILE":
      return `目标不是常规文件（${detail}）`;
    case "FS_STALE_VERSION":
      return `文件在读取后被修改, 请重新读取后重试（${detail}）`;
    case "FS_NOT_OBSERVED":
      return `目标状态未知, 请先读取再写（${detail}）`;
    case "FS_PERMISSION_DENIED":
      return `没有读写权限（${detail}）`;
    case "FS_IO_ERROR":
      return `读写失败（${detail}）`;
    case "FS_ABORTED":
      return `操作已取消（${detail}）`;
    case "FS_SANDBOX_DENIED":
    case "FS_UNAVAILABLE":
      return detail;
  }
}

/** 码表成员判定（映射后端抛来的 `{ code }` 用）。 */
export function isMdFileErrorCode(value: unknown): value is MdFileErrorCode {
  switch (value) {
    case "FS_NOT_FOUND":
    case "FS_NOT_TEXT":
    case "FS_NOT_REGULAR_FILE":
    case "FS_STALE_VERSION":
    case "FS_NOT_OBSERVED":
    case "FS_SANDBOX_DENIED":
    case "FS_PERMISSION_DENIED":
    case "FS_IO_ERROR":
    case "FS_ABORTED":
    case "FS_UNAVAILABLE":
      return true;
    default:
      return false;
  }
}

/** 结构化文件错误: `code` 供上层映射, `message` 是给模型看的详情。 */
export class MdFileError extends Error {
  /** 错误码（见 `MdFileErrorCode`）。 */
  readonly code: MdFileErrorCode;

  constructor(code: MdFileErrorCode, detail: string, cause?: unknown) {
    super(
      mdFileErrorText(code, detail),
      cause === undefined ? undefined : { cause },
    );
    this.name = "MdFileError";
    this.code = code;
  }
}

/** 取消已发生即抛 `FS_ABORTED`（node 实现与 `ctx.fs` 实现共用）。 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new MdFileError("FS_ABORTED", "调用方已取消");
  }
}

/** 错误转一行详情。 */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** node errno 到本包码的映射（`ctx.fs` 实现不用它, 那里直接读 `FsError.code`）。 */
function codeOfErrno(error: unknown): MdFileErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return "FS_NOT_FOUND";
    case "EACCES":
    case "EPERM":
      return "FS_PERMISSION_DENIED";
    case "EISDIR":
      return "FS_NOT_REGULAR_FILE";
    default:
      return "FS_IO_ERROR";
  }
}

/** node 实现里的一次目标统计结果（版本令牌取 dev / ino / size / mtime 四项）。 */
function versionOf(info: {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number;
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

/** 缺省实现选项。 */
export interface NodeMdFileIoOptions {
  /** 相对路径基准目录; 缺省按 `path.resolve` 语义取当前工作目录。 */
  readonly cwd?: string;
}

/**
 * `node:fs` 实现（库面 / 示例 / 单测缺省）。
 * 只做「接口形状对齐」: 版本由 stat 四项拼成, 写前自比一次; 不做临时文件 + `rename`
 * （原子性由 `ctx.fs` 后端保证, 插件侧不经过本实现）。
 */
export function nodeMdFileIo(options: NodeMdFileIoOptions = {}): MdFileIo {
  const base = options.cwd;
  const absolute = (path: string, cwd: string | undefined): string => {
    const from = cwd ?? base;
    return isAbsolute(path)
      ? path
      : resolvePath(from === undefined ? "." : from, path);
  };
  const statOrUndefined = async (
    target: MdFileTarget,
  ): Promise<MdFileInfo | undefined> => {
    try {
      const info = await stat(target.targetKey);
      return {
        version: versionOf(info),
        type: info.isFile()
          ? "file"
          : info.isDirectory()
            ? "directory"
            : "other",
        size: info.size,
      };
    } catch (error) {
      if (codeOfErrno(error) === "FS_NOT_FOUND") return undefined;
      throw new MdFileError(codeOfErrno(error), detailOf(error), error);
    }
  };
  return {
    async resolve(path, opts) {
      throwIfAborted(opts?.signal);
      const key = absolute(path, opts?.cwd);
      return { targetKey: key, displayPath: key };
    },
    stat(target, signal) {
      throwIfAborted(signal);
      return statOrUndefined(target);
    },
    async readText(target, signal) {
      throwIfAborted(signal);
      let raw: Buffer;
      try {
        raw = await readFile(target.targetKey);
      } catch (error) {
        throw new MdFileError(codeOfErrno(error), detailOf(error), error);
      }
      throwIfAborted(signal);
      // 写路径禁止有损解码：NUL 与非法 UTF-8 一律拒读, 否则写回会把字节静默改成 U+FFFD
      if (raw.includes(0)) {
        throw new MdFileError(
          "FS_NOT_TEXT",
          `二进制文件: ${target.displayPath}`,
        );
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch (error) {
        throw new MdFileError(
          "FS_NOT_TEXT",
          `非法 UTF-8: ${target.displayPath}`,
          error,
        );
      }
    },
    async writeText(target, text, intent, signal) {
      throwIfAborted(signal);
      const current = await statOrUndefined(target);
      if (intent?.kind === "createIfAbsent" && current !== undefined) {
        throw new MdFileError(
          "FS_NOT_OBSERVED",
          `目标已存在: ${target.displayPath}`,
        );
      }
      if (intent?.kind === "replaceIfVersion") {
        if (current === undefined) {
          throw new MdFileError(
            "FS_STALE_VERSION",
            `目标已不存在: ${target.displayPath}`,
          );
        }
        if (current.version !== intent.version) {
          throw new MdFileError(
            "FS_STALE_VERSION",
            `版本已变: ${target.displayPath}`,
          );
        }
      }
      throwIfAborted(signal);
      try {
        await writeFile(target.targetKey, text, "utf8");
      } catch (error) {
        throw new MdFileError(codeOfErrno(error), detailOf(error), error);
      }
      const written = await statOrUndefined(target);
      return { version: written?.version ?? "" };
    },
  };
}
