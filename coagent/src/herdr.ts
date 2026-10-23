/**
 * src/herdr.ts — herdr-use 服务面回执的窄化适配：只做字段提取与错误归一，不封装调用。
 *
 * 服务面（`ctx.get("herdrUse")`）的契约见追踪文档「herdr-use 服务面契约」节：回执统一
 * `ActionResult`（成功带 `payload`，失败带 `error.code` / `message` / `hint`），错误码是
 * **terminal 口径**（`terminal-required` / `terminal-not-registered` / `ambiguous-terminal` …）。
 * 本包不认识 pane / tab 概念，只认 `terminal_id`。
 */

import type { HerdrActionResult } from "./types.ts";

/** 成功回执的载荷（失败或载荷缺失时为空对象）。 */
export function payloadOf(result: HerdrActionResult): Record<string, unknown> {
  if (!result.ok) return {};
  return result.payload ?? {};
}

/** 从 `create` 回执取 `terminal_id`（新契约的唯一定位字段）。 */
export function terminalIdOf(result: HerdrActionResult): string | undefined {
  const value = payloadOf(result)["terminal_id"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 取屏文本（服务面返回完整文本；截断只在工具渲染层）。 */
export function screenTextOf(result: HerdrActionResult): string | undefined {
  if (!result.ok) return undefined;
  const value = payloadOf(result)["text"];
  return typeof value === "string" ? value : undefined;
}

/** 终端是否有前台进程（`info` 的 `running`；缺失按未知处理）。 */
export function runningOf(result: HerdrActionResult): boolean | undefined {
  if (!result.ok) return undefined;
  const value = payloadOf(result)["running"];
  return typeof value === "boolean" ? value : undefined;
}

/** 终端是否已不存在（`terminal-not-registered` 是唯一「确定消失」的证据）。 */
export function isTerminalGone(result: HerdrActionResult): boolean {
  return !result.ok && result.error.code === "terminal-not-registered";
}

/** 失败回执的原文（错误码 + 消息 + 可选提示），用于记录 `fail_reason`。 */
export function errorTextOf(result: HerdrActionResult): string {
  if (result.ok) return "";
  const hint =
    result.error.hint === undefined ? "" : `；提示：${result.error.hint}`;
  return `${result.error.code}: ${result.error.message}${hint}`;
}

/** 附注（服务面在「自动打 label 失败」等场景给的软失败说明）。 */
export function notesOf(result: HerdrActionResult): string[] {
  return result.notes ?? [];
}
