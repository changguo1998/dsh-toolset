// tests/width-eaw.test.ts — EAW 精确宽度表（N/W/A 分层判定）
//
// 背景：旧实现把 0x2B00-0x2BFF、0x2600-0x27BF 等区间**整段**按 2 列，导致
// EAW=N（中性、无歧义窄）字符被高估 1 列（终端按 1 列渲染 → 多留空格）。
// 现改为 EAW 精确表：W/F → 2；A 仅在几何/符号/CJK/emoji 保守区间按 2；
// N 及保守区间外的 A → 1。零宽表与文本符号例外（NARROW_TEXT_SYMBOLS）优先。

import { test } from "node:test";
import assert from "node:assert/strict";
import { charWidth, displayWidth } from "../src/app/layout/markdown.ts";

test("EAW：N（中性）且无 emoji 属性按 1 列（修复旧实现的整段高估）", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["⬤ U+2B24 BLACK LARGE CIRCLE", "\u2B24"],
    ["⬀ U+2B00", "\u2B00"],
    ["→ U+2192", "\u2192"],
    ["↔ U+2194（Emoji 但非 emoji 呈现，项目推荐符号）", "\u2194"],
    ["™ U+2122（< U+2190，排除在 emoji 保守集外）", "\u2122"],
    ["× U+00D7", "\u00D7"],
    ["± U+00B1", "\u00B1"],
  ];
  for (const [name, ch] of cases) {
    assert.equal(charWidth(ch), 1, `${name} 应 1 列`);
  }
});

test("EAW：W/F（无歧义宽）与 emoji 保守集按 2 列", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["⭐ U+2B50 (W)", "\u2B50"],
    ["⚪ U+26AA (W)", "\u26AA"],
    ["⬛ U+2B1B (W)", "\u2B1B"],
    ["汉 U+6C49 (W)", "\u6C49"],
    ["全角Ａ U+FF21 (F)", "\uFF21"],
    ["❤ U+2764 (N + Emoji)", "\u2764"],
    ["✂ U+2702 (N + Emoji)", "\u2702"],
    ["🇨 U+1F1E8 (N + Emoji_Presentation)", "\u{1F1E8}"],
  ];
  for (const [name, ch] of cases) {
    assert.equal(charWidth(ch), 2, `${name} 应 2 列`);
  }
});

test("EAW：A（歧义）仅保守区间按 2 列，区间外按 1 列", () => {
  // 保守区间内（可能被 CJK 字体按全角设计）→ 2 列，防低估撑破
  assert.equal(charWidth("\u2605"), 2, "★ U+2605 在 0x2600-0x27BF 保守区间");
  assert.equal(charWidth("\u2B56"), 2, "U+2B56 在 0x2B00-0x2BFF 保守区间");
  // 保守区间外 → 1 列（几何符号区实测 1 列，与主流终端一致）
  assert.equal(charWidth("\u25CB"), 1, "○ U+25CB");
  assert.equal(charWidth("\u25CF"), 1, "● U+25CF");
  assert.equal(charWidth("\u25EF"), 1, "◯ U+25EF");
  assert.equal(charWidth("\u25A0"), 1, "■ U+25A0");
});

test("宽度判定优先级：零宽 > 文本符号例外 > EAW 表", () => {
  assert.equal(charWidth("\u200D"), 0, "ZWJ 零宽");
  assert.equal(charWidth("\uFE0F"), 0, "VS16 零宽");
  // 文本符号例外优先于「保守区间按 2」：✓/⚠ 位于保守区间但按 1 列
  assert.equal(charWidth("\u2713"), 1, "✓ U+2713");
  assert.equal(charWidth("\u26A0"), 1, "⚠ U+26A0");
});

test("displayWidth：逐字符求和（emoji 序列保守累加，不低估）", () => {
  assert.equal(displayWidth("\u2B24"), 1);
  assert.equal(displayWidth("\u2B24\u2B24"), 2);
  assert.equal(displayWidth("a\u2B24b"), 3);
  assert.equal(displayWidth("\u6C49\u2B24"), 3);
});
