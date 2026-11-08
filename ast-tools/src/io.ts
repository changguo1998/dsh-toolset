/**
 * 文件读写适配：接口 + `node:fs` 缺省实现（项目级追踪文档的 D2 / D3）。
 *
 * 本包只经 `AstFileIo` 碰用户文件：
 * - 插件侧注入 `ctx.fs` 实现（`ast-tools/src/ctx-fs-io.ts`）：解析走 `ctx.fs.resolve`, 读走
 *   `stat` / `readText`, 写走 `ctx.fs.writeText` + 写意图瀑布 + 会话沙箱策略;
 * - 库面、示例与单测缺省用 `nodeAstFileIo()`, 行为与改造前的直写等价;
 * - 错误统一成 `AstFileError`: `code` 沿用官方 `FsError` 码, 对外文案在 `astFileErrorText` 一处映射。
 *
 * 成员名与宿主 `FileSystem` 对齐（`resolve` / `stat` / `readText` / `writeText`）,
 * 另加 `processPath`: ast-grep 是子进程, 需要真实路径, 不透明的 `targetKey` 给不了。
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** 解析后的文件目标（宿主 `FsTarget` 的同形子集）。 */
export interface AstFileTarget {
  /** 后端内部标识（本地后端是规范化路径）; 本包不解析它。 */
  readonly targetKey: string;
  /** 模型 / 界面可见路径。 */
  readonly displayPath: string;
}

/** 解析选项（宿主 `FileSystem.resolve` 的同形子集）。 */
export interface AstResolveOptions {
  /** 相对路径基准目录; 缺省由后端决定。 */
  readonly cwd?: string;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 目标元信息（宿主 `FsInfo` 的同形子集）。 */
export interface AstFileInfo {
  /** 当前版本令牌; 写入时作为 `replaceIfVersion` 的基准。 */
  readonly version: string;
  /** 目标类型。 */
  readonly type: "file" | "directory" | "other";
  /** 普通文件的字节大小。 */
  readonly size?: number;
}

/** 写入意图（宿主 `FsWriteIntent` 的同形子集）。 */
export type AstWriteIntent =
  | { readonly kind: "createIfAbsent" }
  | { readonly kind: "replaceIfVersion"; readonly version: string };

/** 写入结果（宿主 `FsWriteOutcome` 的同形子集）。 */
export interface AstWriteOutcome {
  /** 写入后的版本令牌。 */
  readonly version: string;
}

/**
 * 文件读写面：本包唯一的文件入口。
 * 两个实现见 `nodeAstFileIo`（库面缺省）与 `ctxAstFileIo`（插件侧, 走官方围栏）。
 */
export interface AstFileIo {
  /** 把模型给的路径解析成稳定目标。 */
  resolve(path: string, opts?: AstResolveOptions): Promise<AstFileTarget>;
  /** 子进程可打开的真实路径（ast-grep CLI 的输入）。 */
  processPath(target: AstFileTarget): string;
  /** 读元信息; 目标不存在时为 `undefined`。 */
  stat(
    target: AstFileTarget,
    signal?: AbortSignal,
  ): Promise<AstFileInfo | undefined>;
  /** 读整段 UTF-8 文本（逐字节, 不做换行归一)。 */
  readText(target: AstFileTarget, signal?: AbortSignal): Promise<string>;
  /** 原子写整段 UTF-8 文本; `intent` 缺省即无条件覆盖。 */
  writeText(
    target: AstFileTarget,
    text: string,
    intent?: AstWriteIntent,
    signal?: AbortSignal,
  ): Promise<AstWriteOutcome>;
}

/**
 * 本包对外错误的码表: 前九个沿用官方 `FsError` 码（便于与宿主对拍）,
 * 末一个是本包自有的「宿主没挂 `ctx.fs`」——宿主没有对应码, 单列以区分「服务缺失」与「读写失败」。
 */
export type AstFileErrorCode =
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
 * 错误码到对外文案的映射（本包唯一一处）:
 * `FS_SANDBOX_DENIED` 与 `FS_UNAVAILABLE` 原样透出——前者自带 `[sandbox: …]` 标记与升档指引,
 * 后者本身就是可行动说明; 其余码补一句中文前缀, 原始 message 留在括号里。
 */
export function astFileErrorText(
  code: AstFileErrorCode,
  detail: string,
): string {
  switch (code) {
    case "FS_NOT_FOUND":
      return `文件不存在（${detail}）`;
    case "FS_NOT_TEXT":
      return `目标不是 UTF-8 文本（${detail}）`;
    case "FS_NOT_REGULAR_FILE":
      return `目标不是普通文件（${detail}）`;
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
export function isAstFileErrorCode(value: unknown): value is AstFileErrorCode {
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

/** 结构化文件错误: `code` 供测试与上层分支, `message` 是给模型看的中文。 */
export class AstFileError extends Error {
  /** 错误码（见 `AstFileErrorCode`）。 */
  readonly code: AstFileErrorCode;

  constructor(code: AstFileErrorCode, detail: string, cause?: unknown) {
    super(
      astFileErrorText(code, detail),
      cause === undefined ? undefined : { cause },
    );
    this.name = "AstFileError";
    this.code = code;
  }
}

/** 取消已发生即抛 `FS_ABORTED`（node 实现与 `ctx.fs` 实现共用）。 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AstFileError("FS_ABORTED", "调用方已取消");
  }
}

/** 错误码转一行详情（取 `message`, 没有就 `String`)。 */
function detailOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** node errno 到本包码的映射（`ctx.fs` 实现不用它, 那里直接读 `FsError.code`）。 */
function codeOfErrno(error: unknown): AstFileErrorCode {
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
export interface NodeAstFileIoOptions {
  /** 相对路径基准目录; 缺省按 `path.resolve` 语义取当前工作目录。 */
  readonly cwd?: string;
}

/**
 * `node:fs` 实现（库面 / 示例 / 单测缺省）。
 * 只做「接口形状对齐」, 不复刻围栏与版本令牌语义: 版本由 stat 四项拼成, 写前自比一次。
 * 插件侧不经过它——没有 `ctx.fs` 时 `ctxAstFileIo` 直接给出可行动错误, 不回落这里。
 */
export function nodeAstFileIo(options: NodeAstFileIoOptions = {}): AstFileIo {
  const base = options.cwd;
  const absolute = (path: string, cwd: string | undefined): string => {
    const from = cwd ?? base;
    return isAbsolute(path)
      ? path
      : resolvePath(from === undefined ? "." : from, path);
  };
  const statOrUndefined = async (
    target: AstFileTarget,
  ): Promise<AstFileInfo | undefined> => {
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
      throw new AstFileError(codeOfErrno(error), detailOf(error), error);
    }
  };
  return {
    async resolve(path, opts) {
      throwIfAborted(opts?.signal);
      const key = absolute(path, opts?.cwd);
      return { targetKey: key, displayPath: key };
    },
    processPath(target) {
      return target.targetKey;
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
        throw new AstFileError(codeOfErrno(error), detailOf(error), error);
      }
      throwIfAborted(signal);
      if (raw.subarray(0, 4096).includes(0)) {
        throw new AstFileError(
          "FS_NOT_TEXT",
          `二进制文件: ${target.displayPath}`,
        );
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch (error) {
        throw new AstFileError(
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
        throw new AstFileError(
          "FS_NOT_OBSERVED",
          `目标已存在: ${target.displayPath}`,
        );
      }
      if (intent?.kind === "replaceIfVersion") {
        if (current === undefined) {
          throw new AstFileError(
            "FS_STALE_VERSION",
            `目标已不存在: ${target.displayPath}`,
          );
        }
        if (current.version !== intent.version) {
          throw new AstFileError(
            "FS_STALE_VERSION",
            `版本已变: ${target.displayPath}`,
          );
        }
      }
      throwIfAborted(signal);
      try {
        await writeFile(target.targetKey, text, "utf8");
      } catch (error) {
        throw new AstFileError(codeOfErrno(error), detailOf(error), error);
      }
      const written = await statOrUndefined(target);
      return { version: written?.version ?? "" };
    },
  };
}
