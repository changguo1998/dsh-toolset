/**
 * 测量命令执行与单数字解析。
 *
 * 约定：测量命令由用户提供，stdout 中出现的最后一个数字即本轮指标值
 * （容忍 "score: 0.87"、多行输出等前缀/噪声）。非零退出或解析不到数字
 * 视为测量失败（本轮按无改进处理，不崩溃）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 测量结果。 */
export interface MeasureOutcome {
  /** 解析出的指标值；失败为 null。 */
  value: number | null;
  /** 失败原因（成功为 null）。 */
  error: string | null;
  /** 命令原始输出（stdout+stderr 尾部），供诊断。 */
  output: string;
}

/** 数字形态：整数/小数/科学计数，可带符号。 */
const NUMBER_RE = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * 从输出中解析指标值：取最后一个数字。
 * 无数字返回 null。
 */
export function parseMetricValue(output: string): number | null {
  const matches = [...output.matchAll(NUMBER_RE)];
  const last = matches[matches.length - 1]?.[0];
  if (last === undefined) return null;
  const value = Number(last);
  return Number.isFinite(value) ? value : null;
}

/**
 * 以 /bin/sh -c 执行测量命令（信任契约内命令，与 task-engine 验收同口径）。
 * 超时或非零退出 → 失败；成功但 stdout 无数字 → 失败。
 */
export async function runMeasureCommand(
  cmd: string,
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<MeasureOutcome> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", cmd], {
      timeout: timeoutMs,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    });
    const output = `${stdout}${stderr}`;
    const value = parseMetricValue(String(stdout));
    if (value === null) {
      return {
        value: null,
        error: "stdout 未解析到数字",
        output: tail(output),
      };
    }
    return { value, error: null, output: tail(output) };
  } catch (err) {
    const e = err as {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const output = tail(`${e.stdout ?? ""}${e.stderr ?? ""}`);
    if (e.killed === true || e.code === "ETIMEDOUT") {
      return { value: null, error: `测量命令超时（${timeoutMs}ms）`, output };
    }
    const code = typeof e.code === "number" ? e.code : 1;
    return { value: null, error: `退出码 ${code}`, output };
  }
}

/** 保留输出尾部 500 字符（诊断用，避免状态膨胀）。 */
function tail(output: string): string {
  const text = String(output).trim();
  return text.length > 500 ? text.slice(-500) : text;
}
