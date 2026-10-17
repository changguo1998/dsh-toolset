/**
 * 回执渲染（决策 6）：与官方 bash 的回执同构。
 *
 * 顺序：stdout → 独立 `[stderr]` 段 → 各标记各占一行
 * （沙箱 → 超时 → 信号 / 退出码）；超限提示紧跟在**所属流**之后并给全文路径。
 * 无正文时给 `(no output)`；`output.render` 是全函数（畸形值也渲染出文本，不抛）。
 */

import { isRunFailure } from "./types.ts";
import type {
  SandboxFacts,
  ScriptRunFailure,
  ScriptRunResult,
  ScriptRunValue,
  StreamReceipt,
} from "./types.ts";

/** 无正文时的占位。 */
export const NO_OUTPUT = "(no output)";

/** 一条流：正文 + 截断提示（含全文落盘路径）。 */
function streamText(stream: StreamReceipt): string {
  if (!stream.truncated) return stream.text;
  return `${stream.text}\n[output truncated; full output: ${stream.spillPath ?? "(unavailable)"}]`;
}

/** 沙箱标记：只有「被拒绝」与「能力缺失」两种需要模型知道。 */
function sandboxMarkers(facts: SandboxFacts): string[] {
  const markers: string[] = [];
  if (facts.denied && facts.mode !== undefined) {
    markers.push(`[sandbox: file access denied under ${facts.mode} mode]`);
  }
  if (facts.unavailable !== undefined) {
    markers.push(
      `[sandbox: unavailable; the script ran without confinement (${facts.unavailable})]`,
    );
  }
  return markers;
}

/** 退出状态标记：被信号杀死时只说信号，正常退出时非零码才报。 */
function statusMarkers(result: ScriptRunResult): string[] {
  if (result.signal !== null) return [`[killed by signal: ${result.signal}]`];
  if (result.exitCode !== null && result.exitCode !== 0) {
    return [`[exit code: ${result.exitCode}]`];
  }
  return [];
}

/** 成功结果（含非零退出码）的完整回执文本。 */
export function renderReceipt(result: ScriptRunResult): string {
  const out = streamText(result.stdout);
  const err = streamText(result.stderr);
  let body = out;
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) body = NO_OUTPUT;

  const markers = [
    ...sandboxMarkers(result.sandbox),
    ...(result.timedOut ? [`[timed out after ${result.timeoutMs}ms]`] : []),
    ...statusMarkers(result),
  ];
  if (markers.length === 0) return body;
  if (!body.endsWith("\n")) body += "\n";
  return body + markers.join("\n");
}

/** 预期失败值的回执文本。 */
export function renderFailure(failure: ScriptRunFailure): string {
  const code = failure.code === undefined ? "" : `（${failure.code}）`;
  return `script_run 失败${code}：${failure.error}`;
}

/** 成功结果的形状守卫（`output.render` 面对的是未校验的 JSON 值）。 */
function isRunResult(value: object): value is ScriptRunResult {
  const candidate = value as Partial<ScriptRunResult>;
  return (
    typeof candidate.stdout === "object" &&
    candidate.stdout !== null &&
    typeof candidate.stderr === "object" &&
    candidate.stderr !== null &&
    typeof candidate.timedOut === "boolean" &&
    typeof candidate.timeoutMs === "number" &&
    typeof candidate.sandbox === "object" &&
    candidate.sandbox !== null
  );
}

/**
 * `output.render` 的全函数入口：失败值 / 成功值 / 畸形值都渲染成一段文本，绝不抛。
 * 形参顺序是「args 第一、value 第二」（宿主契约）。
 */
export function renderScriptValue(
  _args: unknown,
  value: unknown,
): Array<{ type: "text"; text: string }> {
  if (typeof value !== "object" || value === null) {
    return [{ type: "text", text: NO_OUTPUT }];
  }
  const candidate = value as ScriptRunValue;
  if (isRunFailure(candidate)) {
    return [{ type: "text", text: renderFailure(candidate) }];
  }
  if (isRunResult(candidate)) {
    return [{ type: "text", text: renderReceipt(candidate) }];
  }
  return [{ type: "text", text: NO_OUTPUT }];
}
