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
    { minBytes: 16384 },
  );
  assert.equal(reason, "spill-notice");
  assert.ok(notice !== null && notice.locator === "/tmp/spill/d.txt");
});

test("shouldCompress：无通知按阈值判定（≥ 触发）", () => {
  const below = shouldCompress("x".repeat(16383), { minBytes: 16384 });
  assert.equal(below.reason, "none");
  const at = shouldCompress("x".repeat(16384), { minBytes: 16384 });
  assert.equal(at.reason, "threshold");
  assert.equal(at.notice, null);
});

test("shouldCompress：阈值按 UTF-8 字节计（多字节文本边界）", () => {
  // 多字节文本：字符数远小于字节数。6000 汉字 = 18000 字节 ≥ 16384 → 触发
  // （按字符口径 6000 < 16384 会漏判，这正是本用例守住的回归）
  const over = shouldCompress("汉".repeat(6000), { minBytes: 16384 });
  assert.equal(over.reason, "threshold");
  // 边界下方：5000 汉字 = 15000 字节 < 16384 → 不触发
  const under = shouldCompress("汉".repeat(5000), { minBytes: 16384 });
  assert.equal(under.reason, "none");
  assert.equal(Buffer.byteLength("汉".repeat(5000), "utf8"), 15000);
});

test("shouldCompress：空 locator 的通知不触发 spill-notice，回落阈值", () => {
  // 手工构造：locator 为空（通知畸形）
  const text = `preview\n\n(Omitted 10 bytes. Full formatted result stored at: . ${HINT})`;
  // 严格正则要求 locator 至少 1 字符，此处 locator 组捕获空串 → notice.locator === ""
  const { reason } = shouldCompress(text, { minBytes: 999999 });
  assert.equal(reason, "none");
});

test("宽松通知：宿主文案演进（无 retrievalHint）时仍解析出 locator，hint 为空", () => {
  const text = `preview\n\n(Omitted 7 bytes. Full formatted result stored at: /tmp/dir v1.2/out.txt)`;
  const notice = parseSpillNotice(text);
  assert.ok(notice !== null, "严格正则失配后由宽松正则兜底");
  assert.equal(notice.omittedBytes, 7);
  assert.equal(notice.locator, "/tmp/dir v1.2/out.txt");
  assert.equal(notice.retrievalHint, "", "宽松形态不提供取回指引");
  assert.equal(
    shouldCompress(text, { minBytes: 999999 }).reason,
    "spill-notice",
  );
});

test("宽松通知：locator 剥空后返回 null（畸形通知不触发）", () => {
  const text = `preview\n\n(Omitted 5 bytes. Full formatted result stored at: )`;
  assert.equal(parseSpillNotice(text), null);
  assert.equal(shouldCompress(text, { minBytes: 999999 }).reason, "none");
});
