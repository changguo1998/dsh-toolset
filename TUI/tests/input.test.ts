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

test("Alt+Enter = ESC CR / ESC LF 合并为单个 meta+enter", () => {
  const altEnter = { name: "enter", ctrl: false, meta: true, shift: false };
  // ESC CR（0x1b 0x0d）→ 单个 meta+enter
  assert.deepEqual(dec([0x1b, 0x0d]), [altEnter]);
  // ESC LF（0x1b 0x0a）→ 单个 meta+enter
  assert.deepEqual(dec([0x1b, 0x0a]), [altEnter]);
  // 不影响既有序列：单 ESC 仍是 escape；CR=enter、裸 LF=Ctrl+J（输入区换行键）、CRLF 合并 enter
  assert.deepEqual(names([0x0d]), ["enter"]);
  assert.deepEqual(dec([0x0a]), [
    { name: "j", ctrl: true, meta: false, shift: false },
  ]);
  assert.deepEqual(names([0x0d, 0x0a]), ["enter"]); // CRLF 合并不受影响
  assert.deepEqual(names([0x1b]), ["escape"]);
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

test("Tab / Enter / Ctrl+J(LF) / Backspace", () => {
  assert.deepEqual(names([0x09]), ["tab"]);
  assert.deepEqual(names([0x0d]), ["enter"]);
  assert.deepEqual(names([0x0a]), ["j"]);
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

test("bracketed paste 载荷行尾归一：CRLF / 裸 CR 折成换行", () => {
  const start = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
  const end = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];
  const evs = dec([...start, ...enc("第一行\r\n第二行\r第三行"), ...end]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.name, "paste");
  assert.equal(
    evs[0]!.text,
    "第一行\n第二行\n第三行",
    "输入框行分隔符是 \n（与 Ctrl+J 同源）",
  );
});

test("裸 CR 降级：CRLF 多行粘贴不逐行提交（条目 11）", () => {
  // 无 bracketed paste 的终端把粘贴内容按裸字节送入：CRLF 曾是「两个换行 → 两次 enter」
  const evs = dec(enc("第一行\r\n第二行\r\n"));
  assert.deepEqual(
    evs.map((e) => (e.ctrl ? "ctrl+" + e.name : e.name)),
    ["第", "一", "行", "ctrl+j", "第", "二", "行", "ctrl+j"],
    "CRLF 归一为换行插入，不产出 enter",
  );
  assert.equal(evs.filter((e) => e.name === "enter").length, 0, "不自动提交");
});

test("裸 CR 降级：CR-only 多行粘贴（≥2 处换行）", () => {
  const evs = dec(enc("a\rb\rc"));
  assert.deepEqual(
    evs.map((e) => (e.ctrl ? "ctrl+" + e.name : e.name)),
    ["a", "ctrl+j", "b", "ctrl+j", "c"],
  );
});

test("单次 Enter 不受降级影响（独立一块 / 相邻按键合并成一块）", () => {
  assert.deepEqual(names(enc("\r")), ["enter"], "Enter 单块");
  assert.deepEqual(names(enc("\r\n")), ["enter"], "CRLF Enter 单块（两字节）");
  assert.deepEqual(
    names(enc("abc\r")),
    ["a", "b", "c", "enter"],
    "打字被内核合并成一块时仍是 Enter",
  );
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

test("大批量字节线性解码（不抛 RangeError、不做 O(N²) 搬移）", () => {
  // 回归：原实现 feed 用 `pending.push(...arr)`（≥50 万字节直接
  // Maximum call stack size exceeded）且逐字节 shift/splice（100KB 实测 516ms）。
  const d = new KeyDecoder();
  const bytes = Array.from({ length: 500_000 }, (_, i) => 0x61 + (i % 26));
  const t0 = performance.now();
  const evs = d.feed(bytes);
  const ms = performance.now() - t0;
  assert.equal(evs.length, 500_000, "每个字节一个按键事件，不丢不卡");
  assert.ok(ms < 2000, `50 万字节应在 2s 内解完（实测 ${ms.toFixed(0)}ms）`);
});

test("paste 结束标记丢失：超上限即按一次粘贴交出，后续按键恢复", () => {
  // 终端不再发 ESC[201~ / 报文被截断时，原实现会永久停在 paste 模式把后续所有按键吞掉
  const d = new KeyDecoder({ pasteMaxBytes: 64 });
  const start = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]; // ESC[200~
  assert.deepEqual(d.feed(start), [], "进入 paste 模式，暂不产出");
  const body = enc("x".repeat(100));
  const evs = d.feed(body);
  assert.equal(evs.length, 1, "超上限 → 交出一次 paste");
  assert.equal(evs[0]!.name, "paste");
  assert.equal(evs[0]!.text, "x".repeat(100), "已收到的载荷不丢");
  // 退出 paste 模式后，普通按键恢复正常（不再被吞）
  assert.deepEqual(
    d.feed(enc("ok")).map((e) => e.name),
    ["o", "k"],
  );
});

test("paste 载荷跨多块：结束标记跨块边界仍能识别", () => {
  const d = new KeyDecoder();
  const start = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
  const end = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];
  assert.deepEqual(d.feed([...start, ...enc("abc")]), []);
  assert.deepEqual(d.feed(end.slice(0, 3)), [], "半个结束标记");
  const evs = d.feed([...end.slice(3), ...enc("z")]);
  assert.equal(evs.length, 2, "paste + 其后的按键");
  assert.equal(evs[0]!.name, "paste");
  assert.equal(evs[0]!.text, "abc");
  assert.equal(evs[1]!.name, "z");
});
