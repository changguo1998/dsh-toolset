/**
 * src/cli.ts — herdr CLI 薄封装与握手判定
 *
 * 通道口径（设计文档决策项 1）：**CLI 为缺省通道**，仅 `read` / `wait stable` 走 socket。
 * 本模块只做三件事：
 *   1. 握手判定 —— `HERDR_ENV=1` + `HERDR_SOCKET_PATH` + `HERDR_PANE_ID` 三变量齐备才算
 *      「在 herdr 环境内」（与同族插件 `herdr-integration` 的空转口径一致）；二进制定位
 *      顺序为「显式配置 → `HERDR_BIN_PATH` → PATH 上的 `herdr`」。
 *   2. 子进程执行 —— `spawn(bin, args)` **参数数组、不过 shell**（模型给的文本是 argv 元素，
 *      不做字符串拼接，避免二次解释），带超时与两侧输出收集。
 *   3. 结果归一 —— stdout / stderr 的 JSON 信封解析 + 退出码归一（0 ok / 1 运行时错误 /
 *      2 CLI 语法错误；**stderr 有错误信封即判失败，不依赖退出码**）。
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
 * 读取 herdr 握手环境；未在 herdr 内（三变量缺一）返回 undefined。
 *
 * 判定与 `herdr-integration` 的 `readHerdrEnv` 同源（`HERDR_ENV === "1"` 且 socket 路径与
 * pane id 非空），另加二进制定位（`HERDR_BIN_PATH` 作 PATH 兜底）。
 */
export function readHerdrHandshake(
  env: NodeJS.ProcessEnv = process.env,
  explicitBin?: string,
): HerdrHandshake | undefined {
  if (env.HERDR_ENV !== "1") return undefined;
  const socketPath = env.HERDR_SOCKET_PATH;
  const callerPaneId = env.HERDR_PANE_ID;
  if (!socketPath || !callerPaneId) return undefined;
  const binPath = resolveHerdrBin(explicitBin, env);
  return {
    socketPath,
    callerPaneId,
    ...(binPath === null ? {} : { binPath }),
  };
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

/**
 * 同步尽力执行（进程退出回调内使用：此时已无异步事件循环，只能同步送达）。
 * 与 `herdr-integration` 的 `releaseSync` 同形（`spawnSync` + 3s 超时 + 忽略失败）。
 */
export function runHerdrSync(
  binPath: string,
  args: string[],
  timeoutMs = 3000,
): void {
  try {
    spawnSync(binPath, args, { stdio: "ignore", timeout: timeoutMs });
  } catch (err) {
    void err;
  }
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
 */
export function parseEnvelope(stdout: string, stderr: string): ParsedEnvelope {
  for (const text of [stdout, stderr]) {
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
    const result = obj(root.result);
    if (result !== undefined) return { kind: "ok", result };
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
