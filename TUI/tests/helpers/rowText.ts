// tests/helpers/rowText.ts — 测试侧 FrameRow/段序列化辅助
//
// 布局层自 RenderLine[] 迁移到 FrameRow[] 后，测试需要从段结构还原「纯文本」
// 与「旧式 ANSI 文本」来断言（等价旧 RenderLine.text 语义），并直接检查段样式。
// 纯文本 = 各段 text 拼接；ANSI = 以渲染层 segStyle 逐段序列化（等同于原 styleLine）。

import { THEMES } from "../../src/renderer/theme.ts";
import { segStyle, type FrameRow, type FrameSegment } from "../../src/renderer/screen.ts";
import type { ThemeId } from "../../src/renderer/theme.ts";

/** 行纯文本 = 各段 text 拼接（剥离样式） */
export function rowText(row: FrameRow): string {
  return row.segments.map((s) => s.text).join("");
}

/** 行序列化为旧式 ANSI 文本（按主题；用于 strip/SGR 断言） */
export function rowAnsi(row: FrameRow, themeId: ThemeId = "dark"): string {
  const theme = THEMES[themeId];
  return row.segments.map((s) => segStyle(s, theme)).join("");
}

/** 段数组序列化为 ANSI 文本（wrapInlineMarkdown 等返回 FrameSegment[][] 的场景） */
export function segsAnsi(segs: FrameSegment[], themeId: ThemeId = "dark"): string {
  const theme = THEMES[themeId];
  return segs.map((s) => segStyle(s, theme)).join("");
}

/** 从多行 FrameRow[] 提取纯文本数组 */
export function rowsText(rows: FrameRow[]): string[] {
  return rows.map(rowText);
}
