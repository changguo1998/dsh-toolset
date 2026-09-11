/**
 * ast-grep 二进制探测与子进程执行封装。
 *
 * 选型（详见 README「二进制选型」）：采用系统 ast-grep CLI 而非 @ast-grep/napi 绑定——
 * CLI 支持 25+ 语言、原生 YAML 规则执行（含 fix 重写）与结构化 JSON 输出；
 * napi 绑定仅内置 5 种语言且规则配置无 fix/rewrite 字段，无法覆盖「多语言 + 规则」交付项。
 * 探测顺序：显式 bin 参数 → AST_GREP_BIN 环境变量 → PATH（ast-grep → sg）→ 本地 node_modules/.bin。
 * 二进制缺失时抛 AstGrepMissingError，报错信息内写明全部安装路径。
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstOptions } from "./types.ts";

/** 默认子进程超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 安装指引文本（降级报错信息引用）。 */
export const INSTALL_GUIDANCE = [
  "ast-grep 安装方式（任选其一）：",
  "  1. npm install -g @ast-grep/cli   # 安装 ast-grep / sg 二进制（推荐）",
  "  2. brew install ast-grep          # macOS",
  "  3. cargo install ast-grep         # Rust 工具链",
  "  4. 下载预编译二进制: https://github.com/ast-grep/ast-grep/releases",
  "或用 AST_GREP_BIN 环境变量 / 插件配置 bin 字段指定二进制绝对路径。",
].join("\n");

/** ast-grep 错误基类。 */
export class AstGrepError extends Error {}

/** 二进制未找到（降级报错：信息内写明安装路径）。 */
export class AstGrepMissingError extends AstGrepError {
  constructor() {
    super(
      "未找到 ast-grep 二进制（探测顺序：显式 bin → AST_GREP_BIN → PATH[ast-grep, sg] → 本地 node_modules/.bin）。\n" +
        INSTALL_GUIDANCE,
    );
    this.name = "AstGrepMissingError";
  }
}

/** CLI 执行失败（非零退出且无可解析的 JSON 输出；常见：模式/语言/规则文件错误）。 */
export class AstGrepProcessError extends AstGrepError {
  readonly exitCode: number;
  readonly stderr: string;
  constructor(args: string, exitCode: number, stderr: string) {
    super(
      `ast-grep 执行失败（${args}），exit=${exitCode}：\n${stderr.trim() || "（无 stderr 输出）"}`,
    );
    this.name = "AstGrepProcessError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** JSON 输出解析失败。 */
export class AstGrepJsonError extends AstGrepError {
  constructor(args: string, stdout: string, cause: unknown) {
    super(
      `ast-grep JSON 输出解析失败（${args}）：${String(cause)}\nstdout 前 400 字符：\n${stdout.slice(0, 400)}`,
    );
    this.name = "AstGrepJsonError";
    this.cause = cause;
  }
}

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

/** 在 PATH 环境变量中查找可执行文件，返回绝对路径（未找到返回 null）。 */
function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 查找本地 node_modules/.bin/ast-grep（@ast-grep/cli 以项目依赖安装时的回落路径）。
 * 覆盖 process.cwd() 与从本文件位置推断的包根（src/ 或 dist/src/ 上溯两级）。
 */
function findLocalBin(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const roots = [process.cwd(), here, join(here, ".."), join(here, "..", "..")];
  for (const root of roots) {
    const candidate = join(root, "node_modules", ".bin", "ast-grep");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 探测 ast-grep 二进制路径；未找到返回 null（不抛错）。
 * 顺序：显式 bin 参数 → AST_GREP_BIN → PATH ast-grep → PATH sg → 本地 node_modules/.bin。
 */
export function findAstGrepBin(bin?: string): string | null {
  if (bin) return isExecutableFile(bin) ? bin : null;
  const envBin = process.env.AST_GREP_BIN;
  if (envBin && isExecutableFile(envBin)) return envBin;
  return findOnPath("ast-grep") ?? findOnPath("sg") ?? findLocalBin();
}

/** 获取二进制路径；未找到抛 AstGrepMissingError（报错含安装指引）。 */
export function ensureAstGrepBin(bin?: string): string {
  const found = findAstGrepBin(bin);
  if (!found) throw new AstGrepMissingError();
  return found;
}

/** 子进程执行结果。 */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 执行 ast-grep 子进程并等待结束（超时 SIGKILL，exitCode=-1 并标注超时）。 */
export function runCli(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        stdout,
        stderr: `timeout: ${timeoutMs}ms 超时被终止`,
        exitCode: -1,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AstGrepError(`ast-grep 启动失败（${bin}）：${String(error)}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/**
 * 解析 --json=compact 输出（单行 JSON 数组）。
 * 无命中时 run 以 exit=1 输出 `[]`，scan 的 error 级命中也非零退出但 stdout 仍为纯 JSON——
 * 因此「stdout 可解析出 JSON 数组」即为正常结果，与退出码无关。
 */
export function parseJsonArray(args: string, stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end <= start) {
    throw new AstGrepJsonError(args, trimmed, "未找到 JSON 数组");
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (cause) {
    throw new AstGrepJsonError(args, trimmed, String(cause));
  }
}

/**
 * 通用执行：探测二进制 → 子进程 → JSON 解析。
 * 有 JSON 输出时忽略退出码（无命中/规则命中均可能非零）；
 * 无 JSON 输出且退出非零时抛 AstGrepProcessError（携带 stderr）。
 */
export async function runCliJson(
  args: string[],
  opts: AstOptions = {},
): Promise<unknown[]> {
  const bin = ensureAstGrepBin(opts.bin);
  const result = await runCli(bin, args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (result.stdout.trim()) {
    return parseJsonArray(args.join(" "), result.stdout);
  }
  if (result.exitCode !== 0) {
    throw new AstGrepProcessError(
      args.join(" "),
      result.exitCode,
      result.stderr,
    );
  }
  return [];
}
