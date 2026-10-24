// tests/notice-format.test.ts — notice 行统一前缀（`[hh:mm:ss 来源] 正文`）
//
// 口径见 `src/app/notice-format.ts`：来源取正文自带的 `[来源]` 前缀，缺前缀记 `tui`；
// 多行与已带前缀（幂等）原样返回；正文其余部分逐字保留。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOTICE_SOURCE,
  formatNoticeLine,
} from "../src/app/notice-format.ts";

/** 固定的本地时间（避免时区/时钟漂移）：2026-10-24 09:05:03 */
const T = new Date(2026, 9, 24, 9, 5, 3).getTime();

test("自带来源前缀 → 时间戳包住来源，正文逐字保留", () => {
  assert.equal(
    formatNoticeLine("[session-channel] 已注入 alice ← bob", T),
    "[09:05:03 session-channel] 已注入 alice ← bob",
  );
});

test("来源可含空格（[dsh adapter]）", () => {
  assert.equal(
    formatNoticeLine("[dsh adapter] emit error: boom", T),
    "[09:05:03 dsh adapter] emit error: boom",
  );
});

test("无来源前缀 → 记 tui", () => {
  assert.equal(formatNoticeLine("已取消", T), `[09:05:03 tui] 已取消`);
  assert.equal(DEFAULT_NOTICE_SOURCE, "tui");
});

test("分级词留在正文（warn: / error: 不挪进前缀）", () => {
  assert.equal(
    formatNoticeLine("[rule-engine] warn: 装载期告警", T),
    "[09:05:03 rule-engine] warn: 装载期告警",
  );
});

test("幂等：已带 [hh:mm:ss 来源] 前缀 → 原样返回", () => {
  const once = formatNoticeLine("[rule-engine] warn: x", T);
  assert.equal(formatNoticeLine(once, T + 5000), once);
});

test("多行正文（/help 双列表格等）不加前缀", () => {
  const help = "/help 命令列表\n  /model  切换模型\n  /theme  切换主题";
  assert.equal(formatNoticeLine(help, T), help);
});

test("空白正文原样返回（空行保留语义）", () => {
  assert.equal(formatNoticeLine("", T), "");
  assert.equal(formatNoticeLine("   ", T), "   ");
});

test("时间非法 / 缺省 → 省略时间片段，只留 [来源]", () => {
  assert.equal(
    formatNoticeLine("[session-channel] hi", undefined),
    "[session-channel] hi",
  );
  assert.equal(formatNoticeLine("hi", Number.NaN), "[tui] hi");
});

test("来源前缀后多打的空格被吸收（不重复留白）", () => {
  assert.equal(
    formatNoticeLine("[code-map]   两条线", T),
    "[09:05:03 code-map] 两条线",
  );
});
