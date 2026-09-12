/**
 * 触发判定测试：spill 通知解析（严格/宽松/缺失）+ 阈值判定。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSpillNotice, shouldCompress } from "../src/trigger.ts";

const HINT =
  "Use read with offset/limit, or grep this path to search within it.";

function noticeText(omitted: string, locator: string): string {
  // omitted 直接作为通知内「Omitted <N> bytes」整段（含 unknown 形态 'More bytes were omitted'）
  return `preview line one\npreview line two\n\n(${omitted}. Full formatted result stored at: ${locator}. ${HINT})`;
}

test("解析严格 spill 通知（Omitted N bytes 形态）", () => {
  const notice = parseSpillNotice(
    noticeText("Omitted 12345 bytes", "/tmp/spill/a.txt"),
  );
  assert.ok(notice !== null);
  assert.equal(notice.omittedBytes, 12345);
  assert.equal(notice.locator, "/tmp/spill/a.txt");
  assert.ok(notice.retrievalHint.length > 0);
});

test("解析 unknown 形态（More bytes were omitted，无字节数）", () => {
  const notice = parseSpillNotice(
    noticeText("More bytes were omitted", "/tmp/spill/b.bin"),
  );
  assert.ok(notice !== null);
  assert.equal(notice.omittedBytes, 0);
  assert.equal(notice.locator, "/tmp/spill/b.bin");
});

test("locator 含 '. ' 时严格正则仍能唯一切分", () => {
  const locator = "/tmp/dir v1.2/out file.txt";
  const notice = parseSpillNotice(noticeText("Omitted 10 bytes", locator));
  assert.ok(notice !== null);
  assert.equal(notice.locator, locator);
});

test("无通知文本返回 null", () => {
  assert.equal(parseSpillNotice("plain output without notice"), null);
  assert.equal(parseSpillNotice(""), null);
});

test("通知不在文末（其后还有文本）返回 null", () => {
  const text =
    noticeText("Omitted 10 bytes", "/tmp/spill/c.txt") + "\ntrailing text";
  assert.equal(parseSpillNotice(text), null);
});

test("shouldCompress：spill 通知优先于阈值", () => {
  const { reason, notice } = shouldCompress(
    noticeText("Omitted 10 bytes", "/tmp/spill/d.txt"),
    { minChars: 16384 },
  );
  assert.equal(reason, "spill-notice");
  assert.ok(notice !== null && notice.locator === "/tmp/spill/d.txt");
});

test("shouldCompress：无通知按阈值判定（≥ 触发）", () => {
  const below = shouldCompress("x".repeat(16383), { minChars: 16384 });
  assert.equal(below.reason, "none");
  const at = shouldCompress("x".repeat(16384), { minChars: 16384 });
  assert.equal(at.reason, "threshold");
  assert.equal(at.notice, null);
});

test("shouldCompress：空 locator 的通知不触发 spill-notice，回落阈值", () => {
  // 手工构造：locator 为空（通知畸形）
  const text = `preview\n\n(Omitted 10 bytes. Full formatted result stored at: . ${HINT})`;
  // 严格正则要求 locator 至少 1 字符，此处 locator 组捕获空串 → notice.locator === ""
  const { reason } = shouldCompress(text, { minChars: 999999 });
  assert.equal(reason, "none");
});
