// src/app/notice-format.ts — notice 行统一前缀：`[hh:mm:ss <来源>] 正文`
//
// 口径（2026-10-24 用户要求）：用户可见的 notice 行统一带本地时间与来源名。
// 来源取正文自带的 `[来源]` 前缀（插件 stderr / rule-engine 总线的既有惯例），
// 无前缀的行都是 TUI 自造提示（slash 结果 / 回合收尾 / 配置提示）→ 记 `tui`。
//
// 边界：
// - 多行正文（/help 双列表格等）原样返回：加前缀会破坏悬挂缩进与列对齐；
// - 已带 `[hh:mm:ss 来源]` 前缀的行原样返回（同一行会经缓冲与流水线两条交付路径）；
// - 空白行原样返回（空行保留语义）；
// - 正文其余部分逐字保留：`warn:` / `error:` 等分级词留在正文里（stderr 原文同源，
//   且 externalLogTone 靠它们判 tone 色），时间戳只做「时间 + 来源」这一件事。

import { clockHms } from "./clock.ts";

/** 无来源前缀的行（TUI 自造提示）使用的来源名。 */
export const DEFAULT_NOTICE_SOURCE = "tui";

/** 已有统一前缀（幂等判据）：`[hh:mm:ss 来源]`。 */
const PREFIXED = /^\[\d{2}:\d{2}:\d{2} [^\]]*\]/;

/** 正文自带来源前缀：`[来源]`（来源内不含方括号 / 换行，长度 1 至 40）。 */
const TAG = /^\[([^[\]\r\n]{1,40})\][ \t]*/;

/**
 * notice 正文 → `[hh:mm:ss 来源] 正文`。
 * @param text - 原始正文（多行 / 空白 / 已带前缀 → 原样返回）
 * @param nowMs - 收到该行的时间（epoch ms）；非法值省略时间片段（只留 `[来源]`）
 */
export function formatNoticeLine(text: string, nowMs?: number): string {
  if (text.trim() === "") return text;
  if (text.includes("\n") || text.includes("\r")) return text;
  if (PREFIXED.test(text)) return text;
  const tag = TAG.exec(text);
  const source = tag?.[1] ?? DEFAULT_NOTICE_SOURCE;
  const rest = tag === null ? text : text.slice(tag[0].length);
  const hms = clockHms(nowMs);
  return hms === undefined
    ? `[${source}] ${rest}`
    : `[${hms} ${source}] ${rest}`;
}
