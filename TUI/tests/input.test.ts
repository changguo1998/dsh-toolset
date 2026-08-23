// tests/input.test.ts — KeyDecoder ANSI 输入解码单测（node --test 直跑源码）
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyDecoder, type KeyEvent } from "../src/renderer/input.ts";

function dec(bytes: ArrayLike<number> | string): KeyEvent[] {
  return new KeyDecoder().feed(
    typeof bytes === "string" ? Array.from(Buffer.from(bytes)) : bytes,
  );
}

function enc(text: string): number[] {
  return Array.from(Buffer.from(text));
}
function names(bytes: ArrayLike<number>): string[] {
  return dec(bytes).map((e) => e.name);
}

test("可打印 ASCII 字符逐键解码", () => {
  assert.deepEqual(dec("ab c"), [
    { name: "a", ctrl: false, meta: false, shift: false },
    { name: "b", ctrl: false, meta: false, shift: false },
    { name: " ", ctrl: false, meta: false, shift: false },
    { name: "c", ctrl: false, meta: false, shift: false },
  ]);
});

test("UTF-8 多字节字符（中文）", () => {
  assert.deepEqual(dec("中"), [
    { name: "中", ctrl: false, meta: false, shift: false },
  ]);
});

test("UTF-8 跨 chunk 分片合成", () => {
  const d = new KeyDecoder();
  const bytes = enc("数");
  assert.deepEqual(d.feed(bytes.slice(0, 2)), []); // 字节不足
  assert.deepEqual(d.feed(bytes.slice(2)), [
    { name: "数", ctrl: false, meta: false, shift: false },
  ]);
});

test("方向键 CSI = ESC [ A/B/C/D", () => {
  assert.deepEqual(names([0x1b, 0x5b, 0x41]), ["up"]);
  assert.deepEqual(names([0x1b, 0x5b, 0x42]), ["down"]);
  assert.deepEqual(names([0x1b, 0x5b, 0x43]), ["right"]);
  assert.deepEqual(names([0x1b, 0x5b, 0x44]), ["left"]);
});

test("Home/End 两种编码", () => {
  assert.deepEqual(names([0x1b, 0x5b, 0x48]), ["home"]);
  assert.deepEqual(names([0x1b, 0x5b, 0x46]), ["end"]);
  assert.deepEqual(names([0x1b, 0x5b, 0x31, 0x7e]), ["home"]); // ESC [ 1 ~
  assert.deepEqual(names([0x1b, 0x5b, 0x34, 0x7e]), ["end"]); // ESC [ 4 ~
});

test("PageUp/PageDown + Insert/Delete", () => {
  assert.deepEqual(names([0x1b, 0x5b, 0x35, 0x7e]), ["pageup"]);
  assert.deepEqual(names([0x1b, 0x5b, 0x36, 0x7e]), ["pagedown"]);
  assert.deepEqual(names([0x1b, 0x5b, 0x32, 0x7e]), ["insert"]);
  assert.deepEqual(names([0x1b, 0x5b, 0x33, 0x7e]), ["delete"]);
});

test("Ctrl 组合字节（0x01-0x1a → 字母 + ctrl）", () => {
  assert.deepEqual(dec([0x03]), [
    { name: "c", ctrl: true, meta: false, shift: false },
  ]); // Ctrl+C
  assert.deepEqual(dec([0x0e]), [
    { name: "n", ctrl: true, meta: false, shift: false },
  ]); // Ctrl+N
});

test("ESC 独立键", () => {
  assert.deepEqual(names([0x1b]), ["escape"]);
});

test("ESC + 字母 = meta 键", () => {
  assert.deepEqual(dec([0x1b, 0x61]), [
    { name: "a", ctrl: false, meta: true, shift: false },
  ]);
});

test("Ctrl+方向键（CSI 带修饰符）", () => {
  // ESC [ 1 ; 5 A → Ctrl+Shift+Up（5 = ctrl(4)+shift(1)）
  assert.deepEqual(dec([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x41]), [
    { name: "up", ctrl: true, meta: false, shift: true },
  ]);
  // ESC [ 1 ; 6 C → 6 = ctrl(4)+alt(2) → ctrl+meta（xterm 修饰键编码）
  assert.deepEqual(dec([0x1b, 0x5b, 0x31, 0x3b, 0x36, 0x43]), [
    { name: "right", ctrl: true, meta: true, shift: false },
  ]);
});

test("SS3 应用模式光标键 ESC O A", () => {
  assert.deepEqual(names([0x1b, 0x4f, 0x41]), ["up"]);
  assert.deepEqual(names([0x1b, 0x4f, 0x44]), ["left"]);
});

test("Tab / Enter / Backspace", () => {
  assert.deepEqual(names([0x09]), ["tab"]);
  assert.deepEqual(names([0x0d]), ["enter"]);
  assert.deepEqual(names([0x0a]), ["enter"]);
  assert.deepEqual(names([0x7f]), ["backspace"]);
  assert.deepEqual(names([0x08]), ["backspace"]);
});

test("CR LF 合并为单次 enter（防双触发）", () => {
  assert.deepEqual(names([0x0d, 0x0a]), ["enter"]);
});

test("CSI 跨 chunk 分片：ESC [ A 分两次 feed", () => {
  const d = new KeyDecoder();
  assert.deepEqual(d.feed([0x1b, 0x5b]), []);
  assert.deepEqual(d.feed([0x41]), [
    { name: "up", ctrl: false, meta: false, shift: false },
  ]);
});

test("CSI 中间跨 chunk：ESC [ 1 与 ~ 分开", () => {
  const d = new KeyDecoder();
  assert.deepEqual(d.feed([0x1b, 0x5b, 0x31]), []);
  assert.deepEqual(d.feed([0x7e]), [
    { name: "home", ctrl: false, meta: false, shift: false },
  ]);
});

test("bracketed paste 合成单个 paste 事件", () => {
  const d = new KeyDecoder();
  const bytes = [
    ...[0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e],
    ...Array.from(Buffer.from("hello\nworld")),
    ...[0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e],
  ];
  const evs = d.feed(bytes);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.name, "paste");
  assert.equal(evs[0]!.text, "hello\nworld");
});

test("paste 内容跨 chunk 分片", () => {
  const d = new KeyDecoder();
  const start = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
  const content = Array.from(Buffer.from("分片粘贴内容"));
  const end = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];
  assert.deepEqual(d.feed(start), []);
  assert.deepEqual(d.feed(content.slice(0, 2)), []);
  assert.deepEqual(d.feed(content.slice(2)), []);
  const done = d.feed(end);
  assert.equal(done.length, 1);
  assert.equal(done[0]!.name, "paste");
  assert.equal(done[0]!.text, "分片粘贴内容");
});

test("连续按键混合：字符 + 方向键 + 回车", () => {
  const d = new KeyDecoder();
  const evs = d.feed([0x68, 0x1b, 0x5b, 0x41, 0x0d]);
  assert.deepEqual(
    evs.map((e) => e.name),
    ["h", "up", "enter"],
  );
});

test("未知 CSI 序列丢弃不崩溃", () => {
  assert.deepEqual(dec([0x1b, 0x5b, 0x32, 0x37, 0x7e]), []); // F7 等未知键 → 丢弃
});

test("ESC 后跟控制字节 → 独立 ESC + 该控制键", () => {
  assert.deepEqual(dec([0x1b, 0x08]), [
    { name: "escape", ctrl: false, meta: false, shift: false },
    { name: "backspace", ctrl: false, meta: false, shift: false },
  ]);
});

test("非 ASCII 与 ASCII 混合 + 分片共存", () => {
  const d = new KeyDecoder();
  const buf = Buffer.from("as中df");
  const one = d.feed(buf.subarray(0, 3));
  const two = d.feed(buf.subarray(3));
  assert.deepEqual(
    [...one, ...two].map((e) => e.name),
    ["a", "s", "中", "d", "f"],
  );
});
