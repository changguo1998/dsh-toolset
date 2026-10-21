/**
 * src/cli.ts — herdr CLI 薄封装、可用性握手与探活
 *
 * 通道口径：**CLI 为缺省通道**，仅 `read` / `wait stable` 走 socket。本模块做四件事：
 *   1. 可用性握手 —— **只要二进制可解析**就返回握手；`HERDR_*` 全部可选（dsh 不一定跑在
 *      herdr 内：tmux / 普通终端也可用）。二进制定位顺序为「显式配置 → `HERDR_BIN_PATH` →
 *      PATH 上的 `herdr`」。服务端可达性由 `probeHerdrServerSync`（`herdr status --json`）判，
 *      在 `main.ts` 决定注册时调用。
 *   2. 子进程执行 —— `spawn(bin, args)` **参数数组、不过 shell**（模型给的文本是 argv 元素，
 *      不做字符串拼接，避免二次解释），带超时与两侧输出收集。
 *   3. 结果归一 —— stdout / stderr 的 JSON 信封解析 + 退出码归一（0 ok / 1 运行时错误 /
 *      2 CLI 语法错误；**stderr 有错误信封即判失败，不依赖退出码**）。
 *   4. 同步执行面 —— 进程退出回调里只能同步送达；同一份 `SyncRunner` 也用于探活与真机断言。
 */

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { HerdrHandshake } from "./types.ts";

/** CLI 调用结果（原始观测值）。 */
export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 超时被终止（此时 exitCode 为 -1，stderr 带超时标注）。 */
  timedOut: boolean;
}

/** 可注入的 CLI 执行面（单测注入记录器，不依赖真机 herdr）。 */
export interface HerdrRunner {
  run(args: string[], timeoutMs: number): Promise<CliRunResult>;
}

/** herdr 二进制名（PATH 探测用）。 */
const HERDR_BIN_NAME = "herdr";

/** 判断路径是否为存在且可执行的文件。 */
function isExecutableFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 中查找可执行文件，返回绝对路径（未找到返回 null）。 */
export function findOnPath(
  name: string,
  pathValue: string | undefined = process.env.PATH,
): string | null {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 解析 herdr 二进制路径；解析不到返回 null（不抛错）。
 * 顺序：显式 `explicit` → `HERDR_BIN_PATH` → PATH。
 */
export function resolveHerdrBin(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit !== undefined && explicit !== "") {
    return isExecutableFile(explicit) ? explicit : null;
  }
  const fromEnv = env.HERDR_BIN_PATH;
  if (fromEnv !== undefined && fromEnv !== "" && isExecutableFile(fromEnv)) {
    return fromEnv;
  }
  return findOnPath(HERDR_BIN_NAME, env.PATH);
}

/**
 * 读取 herdr 可用性握手：**二进制可解析即返回**（解析不到返回 undefined）。
 *
 * `HERDR_*` 全部可选：在 herdr 内时带上调用者 pane / tab / workspace 作护栏上下文，
 * 不在时全部省略（不要求在 herdr 内运行）。`HERDR_ENV` 不再参与判定。
 */
export function readHerdrHandshake(
  env: NodeJS.ProcessEnv = process.env,
  explicitBin?: string,
): HerdrHandshake | undefined {
  const binPath = resolveHerdrBin(explicitBin, env);
  if (binPath === null) return undefined;
  const socketPath = nonEmpty(env.HERDR_SOCKET_PATH);
  const callerPaneId = nonEmpty(env.HERDR_PANE_ID);
  const callerTabId = nonEmpty(env.HERDR_TAB_ID);
  const callerWorkspaceId = nonEmpty(env.HERDR_WORKSPACE_ID);
  return {
    binPath,
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(callerPaneId === undefined ? {} : { callerPaneId }),
    ...(callerTabId === undefined ? {} : { callerTabId }),
    ...(callerWorkspaceId === undefined ? {} : { callerWorkspaceId }),
  };
}

/** 非空字符串（其余一律 undefined）。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

/**
 * 缺省执行面：`spawn` 参数数组（不过 shell）、两侧输出全收、超时 SIGKILL。
 * 超时按设计口径**不抛错**：返回 `timedOut: true` 与 exitCode -1，由上层归一到 `timeout` 码。
 */
export function createDefaultRunner(binPath: string): HerdrRunner {
  return {
    run(args: string[], timeoutMs: number): Promise<CliRunResult> {
      return new Promise<CliRunResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const child = spawn(binPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const finish = (
          exitCode: number,
          timedOut: boolean,
          note?: string,
        ): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          // 释放句柄：超时只杀掉直接子进程，孙进程可能仍持有 stdout / stderr 写端；
          // 不主动 destroy 会让**宿主进程**一直等到它们退出（实测 `sh -c 'sleep 5'`
          // 会把测试挂 5 秒），unref 则让子进程句柄不再阻碍事件循环退出。
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          resolve({
            stdout,
            stderr: note === undefined ? stderr : `${stderr}${note}`,
            exitCode,
            timedOut,
          });
        };
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(-1, true, `timeout: ${timeoutMs}ms 超时被终止`);
        }, timeoutMs);
        timer.unref();
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          finish(-1, false, `spawn 失败：${String(error)}`);
        });
        child.on("close", (code) => {
          finish(code ?? -1, false);
        });
      });
    },
  };
}

/** 同步执行结果（探活 / 退出清理 / 真机断言共用）。 */
export interface SyncRunResult {
  stdout: string;
  stderr: string;
  /** 退出码；启动失败或被杀为 null。 */
  status: number | null;
  /** 启动失败 / 超时等错误文本（无错误为 undefined）。 */
  error?: string;
}

/** 同步执行面（可注入：单测不真起子进程）。 */
export type SyncRunner = (args: string[], timeoutMs: number) => SyncRunResult;

/** 构造 `spawnSync` 同步执行面（参数数组、不过 shell、两侧输出全收）。 */
export function createSpawnSyncRunner(binPath: string): SyncRunner {
  return (args, timeoutMs) => {
    try {
      const result = spawnSync(binPath, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error !== undefined) {
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          status: null,
          error: String(result.error),
        };
      }
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        status: result.status,
      };
    } catch (error) {
      return { stdout: "", stderr: "", status: null, error: String(error) };
    }
  };
}

/**
 * 同步尽力执行（进程退出回调内使用：此时已无异步事件循环，只能同步送达）。
 * 与 `herdr-integration` 的 `releaseSync` 同形（`spawnSync` + 3s 超时 + 忽略失败）。
 */
export function runHerdrSync(
  binPath: string,
  args: string[],
  timeoutMs = 3000,
): void {
  createSpawnSyncRunner(binPath)(args, timeoutMs);
}

/** 探活缺省超时（启动期同步调用，别把宿主启动拖成 timeoutMs 那么久）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

/** 服务端探活结果（`main.ts` 据此决定是否注册工具）。 */
export interface HerdrProbeResult {
  ok: boolean;
  /** `herdr status --json` 报出的 socket 路径（有则用作 reader 的缺省）。 */
  socketPath?: string;
  /** 不可达原因（只进日志，不给模型）。 */
  reason?: string;
}

/**
 * 服务端探活：`herdr status --json` → `server.status === "running"`。
 *
 * 为什么用 `status` 而不是 `tab list`：status 同时给出 socket 路径（自定义 socket 的部署
 * 也能拿到），且是纯只读的本地状态查询。失败只返回原因，不抛错（注册条件由调用方判）。
 */
export function probeHerdrServerSync(
  binPath: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  run?: SyncRunner,
): HerdrProbeResult {
  const execute = run ?? createSpawnSyncRunner(binPath);
  const result = execute(["status", "--json"], timeoutMs);
  if (result.error !== undefined) {
    return { ok: false, reason: `herdr status 无法执行：${result.error}` };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 200);
    return {
      ok: false,
      reason: `herdr status 退出码 ${String(result.status)}${detail === "" ? "" : `：${detail}`}`,
    };
  }
  const root = obj(extractJsonObject(result.stdout));
  const server = obj(root?.server);
  if (server?.status !== "running") {
    return {
      ok: false,
      reason: `服务端未运行（server.status=${String(server?.status ?? "缺失")}）`,
    };
  }
  const socket = server.socket;
  return {
    ok: true,
    ...(typeof socket === "string" && socket !== ""
      ? { socketPath: socket }
      : {}),
  };
}

/** herdr 错误信封（stderr 或 stdout 里的 JSON）。 */
export interface HerdrErrorEnvelope {
  code: string;
  message: string;
}

/** 已解析的 herdr 响应：成功取 `result`，失败取错误信封。 */
export type ParsedEnvelope =
  | { kind: "ok"; result: Record<string, unknown> }
  | { kind: "error"; error: HerdrErrorEnvelope }
  | { kind: "unparsed" };

/** 从任意文本里取第一个 JSON 对象（容忍前后噪声；找不到返回 null）。 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 对象取值（非对象返回 undefined）。 */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 解析 herdr 响应信封。
 *
 * 形态（实测 0.9.5）：成功 `{"id":…,"result":{…}}`、失败 `{"error":{"code","message"},"id":…}`。
 * 先看 stdout（多数命令写 stdout），再看 stderr（错误信封实测写 stderr）；两处都没有 JSON
 * 时按 `unparsed` 处理，由调用方按退出码决定文案（如 CLI 语法错误只有一行纯文本）。
 *
 * `exitCode` 可选（socket 读通道没有退出码）：**exit 0 且两侧都没有任何输出**时归一为
 * 「成功 + 空 result」——实测 `pane send-text` / `pane send-keys` / `pane run` 成功时
 * stdout / stderr 都为空（exit 0），不写回执；把「无输出」当 CLI 失败会让这三条命令在真机
 * 全部不可用。非零退出、有错误信封、有输出但解析不出 JSON 时语义不变（仍判失败）。
 */
export function parseEnvelope(
  stdout: string,
  stderr: string,
  exitCode?: number,
): ParsedEnvelope {
  const texts = [stdout, stderr];
  // **错误信封优先**：两侧任一携带 error 即判失败。实测 herdr 把错误写 stderr（exit 1），
  // 但不同子命令的写侧并不统一；只要出现错误信封就不该被另一侧的 result 掩盖（宁可报错）。
  for (const text of texts) {
    const root = obj(extractJsonObject(text));
    if (root === undefined) continue;
    const error = obj(root.error);
    if (error !== undefined && typeof error.code === "string") {
      return {
        kind: "error",
        error: {
          code: error.code,
          message:
            typeof error.message === "string" ? error.message : error.code,
        },
      };
    }
  }
  for (const text of texts) {
    const root = obj(extractJsonObject(text));
    if (root === undefined) continue;
    const result = obj(root.result);
    if (result !== undefined) return { kind: "ok", result };
  }
  // 静默成功：CLI 约定 exit 0 即成功，部分命令不写回执（见上方注释）
  if (exitCode === 0 && texts.every((text) => text.trim() === "")) {
    return { kind: "ok", result: {} };
  }
  return { kind: "unparsed" };
}

/** 退出码归一（0 ok / 1 运行时错误 / 2 CLI 语法错误）。 */
export type CliExitKind = "ok" | "error" | "usage";

export function classifyExit(exitCode: number): CliExitKind {
  if (exitCode === 0) return "ok";
  if (exitCode === 2) return "usage";
  return "error";
}

/**
 * 命令语义标签（仅为超时 / 启动失败等回执可读；不含参数值）。
 */
export function commandLabel(args: string[]): string {
  return `herdr ${args.join(" ")}`;
}

/** 待执行命令（与 runner 对接的最小形态）。 */
export interface HerdrCommand {
  args: string[];
  /** 调用超时（`wait` 的动作级超时由调用方在此叠加，见 actions.ts）。 */
  timeoutMs: number;
}
