/**
 * 执行核：spawn 解释器、把脚本正文写进 stdin、收集两条流、超时与进程组清理、溢出落盘。
 *
 * 口径（决策 6）：
 * - 单条流保留**尾部** `maxOutputChars` 字符；首次越限时把已收全文落盘，之后每片直接追加，
 *   内存只留尾部（超大输出不会把进程撑爆）；回执给落盘路径，模型可再读。
 * - 超时 = `SIGTERM` → 宽限 1s → `SIGKILL`，对象是**进程组**（`detached` + `kill(-pid)`），
 *   避免脚本起的子进程留下孤儿；`stdin` 写完脚本后立即结束（脚本里再读 stdin 得到 EOF）。
 * - 非零退出码不是异常：如实回传 `exitCode` / `signal` / `timedOut`，由回执渲染成标记行。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 进程组清理宽限期（毫秒）：`SIGTERM` 后等这么久再 `SIGKILL`。 */
export const KILL_GRACE_MS = 1_000;

/** 一条流的收集结果。 */
export interface CaptureOutcome {
  /** 保留的尾部文本（未截断时是全文）。 */
  readonly text: string;
  readonly truncated: boolean;
  /** 溢出全文的落盘路径；未截断或落盘失败时缺省。 */
  readonly spillPath?: string;
}

/** 溢出落盘文件：首次写入创建 0600 文件，之后追加。 */
export interface SpillFile {
  readonly path: string;
  /** 追加一段文本（串行调用，顺序即写入顺序）。 */
  write(chunk: string): Promise<void>;
  /** 收尾（每次写入自带 open/close，本实现无持久句柄，保留以对齐契约）。 */
  close(): Promise<void>;
}

/** 落盘后端：每次 `open` 新建一个文件。 */
export interface SpillSink {
  open(
    sessionId: string | undefined,
    stream: "stdout" | "stderr",
  ): Promise<SpillFile>;
}

/**
 * 溢出落盘（仿官方 `spill-local`，决策 6）：
 * 根 = `mkdtemp(<tmpdir>/<prefix>XXXXXX)`（0700，进程内**惰性建一次**）；
 * 其下按会话分桶 `session-<sha256(sessionId) 前 12 位>/`（0700，惰性）；
 * 无会话时落 `session-agentless/`；每次新建一个 **0600** 文件；**不自动删**
 * （可审计，残留交给 `/tmp` 生命周期）。
 */
export class SpillStore implements SpillSink {
  /** 文件名前缀（已由 `resolveSettings` 去掉路径分隔符）。 */
  private readonly prefix: string;

  /** 临时根（测试可注入）。 */
  private readonly tmpRoot: string;

  /** 进程内唯一的 spill 根（惰性创建，避免无溢出时白建目录）。 */
  private rootPromise?: Promise<string>;

  /** 已建好的会话分桶。 */
  private readonly buckets = new Map<string, string>();

  constructor(prefix: string, tmpRoot: string = tmpdir()) {
    this.prefix = prefix;
    this.tmpRoot = tmpRoot;
  }

  /** 惰性建并缓存 spill 根。 */
  private ensureRoot(): Promise<string> {
    this.rootPromise ??= mkdtemp(join(this.tmpRoot, `${this.prefix}XXXXXX`));
    return this.rootPromise;
  }

  /** 取（并惰性建）会话分桶目录。 */
  private async bucketDir(sessionId: string | undefined): Promise<string> {
    const key =
      sessionId === undefined || sessionId === ""
        ? "session-agentless"
        : `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
    const cached = this.buckets.get(key);
    if (cached !== undefined) return cached;
    const dir = join(await this.ensureRoot(), key);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    this.buckets.set(key, dir);
    return dir;
  }

  async open(
    sessionId: string | undefined,
    stream: "stdout" | "stderr",
  ): Promise<SpillFile> {
    const dir = await this.bucketDir(sessionId);
    const path = join(dir, `${randomBytes(6).toString("hex")}-${stream}.log`);
    let created = false;
    return {
      path,
      async write(chunk: string): Promise<void> {
        if (chunk === "") return;
        if (!created) {
          await writeFile(path, chunk, { mode: 0o600, flag: "wx" });
          created = true;
          return;
        }
        await appendFile(path, chunk);
      },
      async close(): Promise<void> {
        // 每次写入自带 open/close，无持久句柄需要收尾。
      },
    };
  }
}

/** 取尾部（不把代理对劈成两半，避免回执里出现半个字符）。 */
function tailOf(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const start = text.length - limit;
  const first = text.charCodeAt(start);
  const lowSurrogateStart = first >= 0xdc00 && first <= 0xdfff;
  return text.slice(lowSurrogateStart ? start + 1 : start);
}

/**
 * 尾部保留的单流收集器：未越限前原样累积；首次越限时把已收全文交给落盘，
 * 之后每片直接落盘、内存只留尾部。落盘失败只丢路径，不影响执行与截断标记。
 */
class StreamCapture {
  private tail = "";

  private truncated = false;

  private spill?: SpillFile;

  private spillFailed = false;

  /** 落盘写入的串行链（`push` 是同步的，写入排队）。 */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly openSpill: (() => Promise<SpillFile>) | undefined,
  ) {}

  /** 收一片输出（同步；落盘异步排队）。 */
  push(chunk: string): void {
    if (chunk === "") return;
    if (!this.truncated) {
      const combined = this.tail + chunk;
      if (combined.length <= this.limit) {
        this.tail = combined;
        return;
      }
      this.truncated = true;
      this.enqueue(combined);
      this.tail = tailOf(combined, this.limit);
      return;
    }
    this.enqueue(chunk);
    this.tail = tailOf(this.tail + chunk, this.limit);
  }

  /** 排队一次落盘（无落盘后端或已失败则只记截断）。 */
  private enqueue(text: string): void {
    const openSpill = this.openSpill;
    if (openSpill === undefined || this.spillFailed) return;
    this.chain = this.chain.then(async () => {
      if (this.spillFailed) return;
      try {
        this.spill ??= await openSpill();
        await this.spill.write(text);
      } catch {
        this.spillFailed = true;
      }
    });
  }

  /** 等落盘排空并给出收集结果。 */
  async finish(): Promise<CaptureOutcome> {
    await this.chain;
    await this.spill?.close();
    return {
      text: this.tail,
      truncated: this.truncated,
      ...(this.truncated && this.spill !== undefined && !this.spillFailed
        ? { spillPath: this.spill.path }
        : {}),
    };
  }
}

/** 一次执行的全部输入。 */
export interface RunOptions {
  /** 要 spawn 的 argv（解释器 + 固定参数；已围栏时是运行器 argv）。 */
  readonly argv: readonly string[];
  /** 脚本正文，经 stdin 交给解释器。 */
  readonly script: string;
  /** 工作目录；缺省继承本进程 cwd。 */
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  /** 调用方取消信号：触发即按进程组终止。 */
  readonly signal?: AbortSignal;
  /** 子进程环境；缺省继承本进程。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 溢出落盘后端；缺省只截断不落盘（回执给 `(unavailable)`）。 */
  readonly spill?: SpillSink;
  /** 会话 id（决定落盘分桶）。 */
  readonly sessionId?: string;
}

/** 一次执行的结果（进程层事实；围栏判定在 tools.ts 里叠加）。 */
export interface RunOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: CaptureOutcome;
  readonly stderr: CaptureOutcome;
  /** 起进程就失败（ENOENT / EACCES 等）时的说明；此时两条流为空。 */
  readonly spawnError?: string;
}

/** 错误转一行说明。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 空收集结果（起进程失败时用）。 */
const EMPTY_CAPTURE: CaptureOutcome = { text: "", truncated: false };

/** 构造一个落盘 opener（`null` = 不落盘）。 */
function makeOpener(
  sink: SpillSink,
  sessionId: string | undefined,
  stream: "stdout" | "stderr",
): () => Promise<SpillFile> {
  return () => sink.open(sessionId, stream);
}

/**
 * 跑一段脚本：spawn → 写 stdin → 收两条流 → 超时/取消时按进程组终止 → 收尾。
 * 起进程失败不抛错，返回带 `spawnError` 的结果（由工具层转成失败值）。
 */
export async function runScript(options: RunOptions): Promise<RunOutcome> {
  const limit = Math.max(1, Math.floor(options.maxOutputChars));
  const spill = options.spill;
  const captureOut = new StreamCapture(
    limit,
    spill === undefined
      ? undefined
      : makeOpener(spill, options.sessionId, "stdout"),
  );
  const captureErr = new StreamCapture(
    limit,
    spill === undefined
      ? undefined
      : makeOpener(spill, options.sessionId, "stderr"),
  );

  const program = options.argv[0];
  if (program === undefined) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: "argv 为空（至少要含解释器路径）",
      stdout: EMPTY_CAPTURE,
      stderr: EMPTY_CAPTURE,
    };
  }

  let child: ChildProcess;
  try {
    child = spawn(program, options.argv.slice(1), {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // 独立进程组：超时按组终止，脚本起的子进程不会留下孤儿。
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: describe(error),
      stdout: EMPTY_CAPTURE,
      stderr: EMPTY_CAPTURE,
    };
  }

  return await new Promise<RunOutcome>((resolve) => {
    let settled = false;
    let spawned = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timers: NodeJS.Timeout[] = [];

    /** 按进程组发信号；组不存在时退回单进程（进程可能已退出）。 */
    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === "win32") {
          child.kill(signal);
          return;
        }
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // 已退出：忽略。
        }
      }
    };

    /** SIGTERM → 宽限 1s → SIGKILL。 */
    const terminate = (): void => {
      killGroup("SIGTERM");
      const timer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
      timers.push(timer);
    };

    /** 取消信号：与超时同一条终止路径。 */
    const onAbort = (): void => {
      terminate();
    };

    /** 收尾（幂等）：清定时器、排空落盘、给结果。 */
    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      void (async () => {
        const stdout = await captureOut.finish();
        const stderr = await captureErr.finish();
        resolve({
          exitCode: code,
          signal,
          timedOut,
          ...(spawnError === undefined ? {} : { spawnError }),
          stdout,
          stderr,
        });
      })();
    };

    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      spawnError = describe(error);
      // 起不来时不会有 close，直接收尾；起得来之后的其他错误交给 close。
      if (!spawned) finish(null, null);
    });
    child.once("close", (code, signal) => {
      finish(code, signal ?? null);
    });

    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        captureOut.push(chunk);
      });
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        captureErr.push(chunk);
      });
    }
    if (child.stdin !== null) {
      // 脚本写完后立即 EOF；解释器先退出导致的 EPIPE 不算错误。
      child.stdin.on("error", () => {});
      child.stdin.end(options.script);
    }

    timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        terminate();
      },
      Math.max(1, Math.floor(options.timeoutMs)),
    );

    if (options.signal?.aborted === true) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}
