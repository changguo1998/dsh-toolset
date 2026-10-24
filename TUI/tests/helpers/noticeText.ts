// tests/helpers/noticeText.ts — notice 行统一前缀的测试口径（`[hh:mm:ss 来源] 正文`）
//
// 前缀带实时时钟（`app/notice-format.ts`），逐字断言正文前先用本模块归一：
// - stripNoticePrefix：去掉**行首**前缀（保留正文，用于「首行是什么」这类断言）；
// - flatRows：整屏拼成一段（去 ANSI、边框竖线与所有空白），用于长 notice 被折行后的
//   包含断言——折行处直接相接，正文里的空格也一并消掉，needle 同样按无空白拼。

/** 行首前缀：`[hh:mm:ss 来源] `（来源可含空格，如 `dsh adapter`）。 */
const PREFIX_AT_START = /^\[\d{2}:\d{2}:\d{2} [^\]]*\] /;

/** 任意位置的前缀（整屏文本归一用）。 */
const PREFIX_ANY = /\[\d{2}:\d{2}:\d{2} [^\]]*\] /g;

/** 去掉行首的 notice 前缀；无前缀原样返回。 */
export function stripNoticePrefix(text: string): string {
  return text.replace(PREFIX_AT_START, "");
}

/** 整屏行 → 一段文本：去 ANSI、边框竖线、notice 前缀与所有空白。 */
export function flatRows(rows: readonly string[]): string {
  return rows
    .join("")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[│┃|]/g, "")
    .replace(PREFIX_ANY, "")
    .replace(/\s+/g, "");
}
