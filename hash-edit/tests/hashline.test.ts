/**
 * hashline 测试：行拆分、行哈希固定向量、锚点解析/格式化、换行符口径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HASH_LEN,
  detectLineEnding,
  fileHash,
  formatAnchor,
  hashLine,
  hashlines,
  parseLineAnchor,
  splitLines,
} from "../src/hashline.ts";

test("splitLines: 行尾 \\n 不产生独立行，中间空行保留", () => {
  assert.deepEqual(splitLines(""), [""]);
  assert.deepEqual(splitLines("a"), ["a"]);
  assert.deepEqual(splitLines("a\n"), ["a"]);
  assert.deepEqual(splitLines("\n"), [""]);
  assert.deepEqual(splitLines("a\n\nb"), ["a", "", "b"]);
  assert.deepEqual(splitLines("a\n\nb\n"), ["a", "", "b"]);
});

test("splitLines: CRLF 按换行拆分且 \\r 不入行内容", () => {
  assert.deepEqual(splitLines("abc\r\ndef\r\n"), ["abc", "def"]);
  assert.deepEqual(splitLines("a\r\n\r\nb\r\n"), ["a", "", "b"]);
});

test("splitLines: 孤立 \\r 不作为换行符", () => {
  assert.deepEqual(splitLines("a\rb"), ["a\rb"]);
});

test("hashLine: sha256 前 8 位 hex 固定向量", () => {
  // 固定向量钉死算法：sha256("") 与 sha256("abc") 的前 8 位
  assert.equal(hashLine(""), "e3b0c442");
  assert.equal(hashLine("abc"), "ba7816bf");
  assert.equal(hashLine("hello"), "2cf24dba");
  // CRLF 行尾符不入哈希（哈希输入为去行尾的行文本）
  assert.notEqual(hashLine("abc\r"), hashLine("abc"));
  // 长度与字符集
  assert.equal(hashLine("x").length, HASH_LEN);
  assert.match(hashLine("x"), /^[0-9a-f]{8}$/);
});

test("fileHash: 完整 64 位 hex，与行哈希口径独立", () => {
  const h = fileHash("a\n");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(
    h.slice(0, HASH_LEN) === hashLine("a"),
    false,
    "整文件哈希不是单行哈希",
  );
});

test("hashlines: 行号 1 基、哈希与文本对应", () => {
  const rows = hashlines("alpha\nbeta\n\ndelta\n");
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.line),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    rows.map((r) => r.text),
    ["alpha", "beta", "", "delta"],
  );
  assert.equal(rows[2]?.hash, hashLine(""));
  assert.equal(rows[2]?.hash, "e3b0c442");
  assert.equal(rows[3]?.hash, hashLine("delta"));
});

test("detectLineEnding: 出现 CRLF 即 CRLF 口径，否则 LF", () => {
  assert.equal(detectLineEnding("a\nb\n"), "\n");
  assert.equal(detectLineEnding("a\r\nb\r\n"), "\r\n");
  assert.equal(detectLineEnding("a\nb\r\nc\n"), "\r\n");
  assert.equal(detectLineEnding(""), "\n");
});

test("parseLineAnchor: 合法锚点（含大写归一、首尾空白容忍）", () => {
  const a = parseLineAnchor("12:e3b0c442");
  assert.ok(a.ok);
  if (a.ok) assert.deepEqual(a.anchor, { line: 12, hash: "e3b0c442" });

  const b = parseLineAnchor(" 3:ABCDEF12 ");
  assert.ok(b.ok);
  if (b.ok) assert.deepEqual(b.anchor, { line: 3, hash: "abcdef12" });
});

test("parseLineAnchor: 非法锚点", () => {
  const bad = [
    "",
    "1",
    "1:",
    "1:e3b0c44", // 7 位
    "1:e3b0c4422", // 9 位
    "1:zzzzzzzz", // 非 hex
    "0:e3b0c442", // 行号 0
    "-1:e3b0c442", // 负数（正则亦拒绝）
    "1.5:e3b0c442", // 非整行号
    "1e3b0c442", // 缺冒号
    " 1:e3b0c442 extra", // 尾随词
  ];
  for (const anchor of bad) {
    const r = parseLineAnchor(anchor);
    assert.ok(!r.ok, `expected malformed: ${JSON.stringify(anchor)}`);
  }
});

test("formatAnchor: `${line}:${hash}`", () => {
  assert.equal(formatAnchor(7, "ba7816bf"), "7:ba7816bf");
});
