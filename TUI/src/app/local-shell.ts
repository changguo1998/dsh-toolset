// src/app/local-shell.ts — `$`（shell）模式的本地执行（BACKLOG TUI#37）
//
// 语义（条目决策）：
//   - **本地子进程**执行（`sh -c` / Windows 走 `cmd.exe`），**不经模型**、不占审批链；
//   - 非交互（`node-pty` 已评估、暂不引入，见 docs/DESIGN.md 技术选型）——只收 stdout/stderr；
//   - 有界超时（缺省 30s）到点先 SIGTERM、宽限后 SIGKILL；输出有界（缺省 2 万字符）截断；
//   - 不做危险命令黑名单：命令回显本身即审计，护栏职责归 security-guard（避免两套口径）。
//
// 本模块是纯 IO 边界：只做 spawn 封装与输出聚合，渲染/状态变更由调用方（App）负责。

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 一次本地命令的结果（与渲染无关的原始事实） */
export interface ShellRunResult {
  /** 退出码（被信号终止时为 null） */
  code: number | null;
  /** 终止信号（如 SIGTERM / SIGKILL） */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** 超时被终止 */
  timedOut: boolean;
  /** 输出是否被上限截断 */
  truncated: boolean;
}

export interface ShellRunOptions {
  /** 工作目录（缺省进程 cwd） */
  cwd?: string;
  /** 超时（ms），缺省 SHELL_TIMEOUT_MS */
  timeoutMs?: number;
  /** 单流输出上限（字符），缺省 SHELL_MAX_OUTPUT_CHARS */
  maxOutputChars?: number;
}

/** 执行器类型（App 依赖注入用，测试可换假实现） */
export type ShellRunner = (
  command: string,
  options?: ShellRunOptions,
) => Promise<ShellRunResult>;

/** 展开 `~`：状态栏 cwd 是**显示用缩写**（`~/Projects/x`，见 status.ts `shortenHome`），
 *  不能直接当文件系统路径用（`~` 不展开 → spawn ENOENT，真机 2026-09-27 踩到）。 */
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 归一可用的工作目录（BACKLOG TUI#37 真机缺陷修复）：
 * `~` 展开 → 必须是**存在的目录** → 否则回落 `process.cwd()` → 仍不可用则 undefined。
 * 传入显示占位（`—`/空）或已消失的目录时不再让 spawn 报出误导性的
 * `spawn /bin/sh ENOENT`，而是走可用目录或明确报错。
 */
export function resolveShellCwd(cwd?: string): string | undefined {
  const candidates = [
    cwd === undefined || cwd === "" || cwd === "—"
      ? undefined
      : expandTilde(cwd),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (c === undefined) continue;
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      // 不存在 / 不可访问 → 试下一个候选
    }
  }
  return undefined;
}

/** 缺省超时：30s（BACKLOG TUI#37 决策） */
export const SHELL_TIMEOUT_MS = 30_000;
/** 缺省单流输出上限（字符）：约 2 万，超出截断并标注 */
export const SHELL_MAX_OUTPUT_CHARS = 20_000;

/** 截断到上限（超出时保留头部 + 标注；返回是否截断） */
function capText(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** 真实执行器：spawn(命令, { shell: true })；stdout/stderr 全量收集后聚合。
 *  超时：SIGTERM → 宽限 1s → SIGKILL；`close` 时结算（code/signal/timedOut）。 */
export const runShellCommand: ShellRunner = (command, options = {}) => {
  const timeoutMs = options.timeoutMs ?? SHELL_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? SHELL_MAX_OUTPUT_CHARS;
  const cwd = resolveShellCwd(options.cwd);
  // 无可用目录（传入目录已消失且进程 cwd 也不可用）→ 明确失败，不进 spawn
  if (cwd === undefined) {
    return Promise.resolve({
      code: null,
      signal: null,
      stdout: "",
      stderr: "无可用工作目录（传入目录与进程 cwd 均不可访问）",
      timedOut: false,
      truncated: false,
    });
  }
  return new Promise<ShellRunResult>((resolveRun) => {
    let timedOut = false;
    const child = spawn(command, {
      shell: true,
      cwd,
      // 交互式命令（如 vim）在本项不支持：stdin 直接关闭，避免挂死
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length <= maxOutputChars) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length <= maxOutputChars) stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // 宽限 1s：仍不退出则强杀
      setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    // spawn 失败（如 shell 不在 PATH）：保守返回失败结果，不抛；带上 cwd 便于定位
    // （`spawn … ENOENT` 的报错指向命令名，实际常是 cwd 不可用）
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      const msg = `spawn 失败：${err.message}（cwd=${cwd}）`;
      const out = capText(stdout, maxOutputChars);
      resolveRun({
        code: null,
        signal: null,
        stdout: out.text,
        stderr: capText(stderr + msg, maxOutputChars).text,
        timedOut,
        truncated: out.truncated,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = capText(stdout, maxOutputChars);
      const err = capText(stderr, maxOutputChars);
      resolveRun({
        code,
        signal: signal ?? null,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        truncated: out.truncated || err.truncated,
      });
    });
  });
};

/** 一行 shell 输出（App 落 buffer 与渲染共用；tone 走既有 notice 语义色） */
export interface ShellOutputLine {
  text: string;
  tone?: "success" | "warn" | "error" | "info";
}

/** 把「命令 + 结果」折成活动区行：命令回显 → stdout → stderr → 退出摘要。
 *  空输出不产行；行内不含 ANSI（渲染层统一着色）。 */
export function shellResultLines(
  command: string,
  result: ShellRunResult,
  elapsedMs: number,
): ShellOutputLine[] {
  const lines: ShellOutputLine[] = [{ text: `$ ${command}`, tone: "info" }];
  for (const l of result.stdout.replace(/\r\n/g, "\n").split("\n")) {
    if (l !== "") lines.push({ text: l });
  }
  for (const l of result.stderr.replace(/\r\n/g, "\n").split("\n")) {
    if (l !== "") lines.push({ text: l, tone: "error" });
  }
  if (result.truncated) {
    lines.push({ text: "（输出过长，已截断）", tone: "warn" });
  }
  // 退出摘要：超时 → 黄；退出码非 0 / 被信号杀 → 红；成功 → 绿
  const ms = Math.max(0, Math.round(elapsedMs));
  if (result.timedOut) {
    lines.push({
      text: `→ 超时（${Math.round(SHELL_TIMEOUT_MS / 1000)}s）已终止 · ${ms}ms`,
      tone: "warn",
    });
  } else if (result.code === 0) {
    lines.push({ text: `→ 退出码 0 · ${ms}ms`, tone: "success" });
  } else if (result.code === null && result.signal === null) {
    // 进程没起来（spawn 失败）→ 别说「被信号 ? 终止」（误导），直接报启动失败
    lines.push({ text: `→ 启动失败（未执行） · ${ms}ms`, tone: "error" });
  } else {
    const how =
      result.code !== null
        ? `退出码 ${result.code}`
        : `被信号 ${result.signal ?? "?"} 终止`;
    lines.push({ text: `→ ${how} · ${ms}ms`, tone: "error" });
  }
  return lines;
}
