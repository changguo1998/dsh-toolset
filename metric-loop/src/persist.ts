/**
 * 循环状态持久化：JSON 文件，原子写（tmp + rename）。
 *
 * 状态文件是跨进程唤醒的载体——每次 dsh 启动（= 一次 schedule 唤醒）
 * 重新加载状态推进一轮，循环语义由此跨进程延续。
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";

import type { LoopState } from "./types.ts";

/** 状态文件 schema 版本（不兼容时拒绝加载，避免静默错语义）。 */
export const STATE_VERSION = 1;

/** 轮次历史上限（只保留最近 N 轮，防状态膨胀）。 */
const HISTORY_LIMIT = 500;

/** 循环 id 归一化：仅保留文件名字符，防路径逃逸。 */
export function sanitizeLoopId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return clean.length > 0 ? clean : "default";
}

/** 状态文件路径。 */
export function statePathFor(stateDir: string, id: string): string {
  return path.join(stateDir, `metric-loop-${sanitizeLoopId(id)}.json`);
}

/** 加载状态；文件缺失返回 null，版本/内容不合法抛错。 */
export function loadState(stateDir: string, id: string): LoopState | null {
  const file = statePathFor(stateDir, id);
  if (!existsSync(file)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`状态文件损坏（非合法 JSON）：${file} — ${String(err)}`);
  }
  if (raw["version"] !== STATE_VERSION) {
    throw new Error(
      `状态文件版本不兼容（version=${String(raw["version"])}，要求 ${STATE_VERSION}）：${file}`,
    );
  }
  const state = raw["state"] as LoopState | undefined;
  if (state === undefined || typeof state !== "object") {
    throw new Error(`状态文件缺少 state 段：${file}`);
  }
  // 基本形状校验（防手改/损坏导致运行期抛更隐蔽的错）
  for (const key of [
    "id",
    "spec",
    "rounds",
    "best",
    "streak",
    "tokensUsed",
    "status",
    "stopReason",
    "history",
  ] as const) {
    if (state[key] === undefined)
      throw new Error(`状态文件缺少字段 ${key}：${file}`);
  }
  return state;
}

/** 原子写状态（截断历史至上限后落盘）。 */
export function saveState(stateDir: string, state: LoopState): void {
  const file = statePathFor(stateDir, state.id);
  mkdirSync(stateDir, { recursive: true });
  // 历史截断：只保留最近 HISTORY_LIMIT 轮
  if (state.history.length > HISTORY_LIMIT) {
    state.history = state.history.slice(-HISTORY_LIMIT);
  }
  const payload = JSON.stringify({ version: STATE_VERSION, state }, null, 2);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, file);
}
