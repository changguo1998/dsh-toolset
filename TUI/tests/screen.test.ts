// tests/screen.test.ts — Screen 帧写出（光标定位）单测
//
// REGRESSION: 满高帧下 input 行为最后一行，旧实现尾部 CRLF 触发触底上滚，
// 硬件光标落在输入行下一行(与显示不符)。修复后尾部只跟 \x1b[K 与定位转义。
// 2026-08-31: 按键提示区加入后输入行不再占末行，改为统一规则「仅帧末行不写 CRLF」，
// 保证提示区另起一行；并修掉无 caret 行的面板帧末行 CRLF 的触底上滚 1 行问题。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen, type RenderLine } from "../src/renderer/screen.ts";

function capture(
  lines: RenderLine[],
  cols: number,
  rows: number,
  startLine = 1,
  delta = false,
) {
  let out = "";
  const s = new Screen({ write: (x) => (out += x) });
  s.resize(cols, rows);
  if (delta) s.renderDelta(startLine, lines);
  else s.render(lines);
  return out;
}

test("满高帧 render：输入行(caret)后无 CRLF，光标精确落在输入行", () => {
  const footer: RenderLine = { text: "> Type a message...", caret: 2 };
  const lines: RenderLine[] = [
    ...Array.from({ length: 23 }, (_, i) => ({ text: `line${i}` })),
    footer,
  ];
  const out = capture(lines, 40, 24);
  // 输入行文本之后必须是定位转义，不能有 \r\n(避免触底上滚)
  const idx = out.lastIndexOf(footer.text);
  assert.ok(idx >= 0, "输出应包含输入行");
  assert.ok(
    !out.slice(idx + footer.text.length).includes("\r\n"),
    "输入行尾不得有 CRLF",
  );
  assert.equal(
    out.slice(idx + footer.text.length),
    "\x1b[24;3H",
    "光标应定位到第24行第3列",
  );
});

test("非满高帧 render：普通行保留 CRLF，输入行仍定位正确", () => {
  const footer: RenderLine = { text: "> Type a message...", caret: 2 };
  const out = capture([{ text: "header" }, footer], 40, 24);
  const idx = out.lastIndexOf(footer.text);
  assert.equal(
    out.slice(idx + footer.text.length),
    "\x1b[2;3H",
    "光标在第2行第3列",
  );
  assert.ok(out.includes("header\r\n"), "普通行保留 CRLF");
});

test("renderDelta 满高帧：startLine+i 为末行时输入行不 CRLF，光标仍在输入行", () => {
  const footer: RenderLine = { text: "> hello", caret: 7 };
  const out = capture([footer], 40, 24, 24, true); // startLine=24，即最后一行
  const idx = out.lastIndexOf(footer.text);
  const tail = out.slice(idx + footer.text.length);
  assert.ok(!tail.includes("\r\n"), "delta 输入行尾不得有 CRLF(避免触底上滚)");
  assert.equal(tail, "\x1b[K\x1b[24;8H", "先擦行尾再定位到第24行第8列");
});

test("renderDelta 非满高帧：输入行 CRLF-替换为 K + 定位，位置正确", () => {
  const footer: RenderLine = { text: "> ab", caret: 4 };
  const out = capture([{ text: "scrolled" }, footer], 40, 24, 5, true);
  const idx = out.lastIndexOf(footer.text);
  const tail = out.slice(idx + footer.text.length);
  assert.equal(tail, "\x1b[K\x1b[6;5H", "输入行在 delta 中行为一行带擦除+定位");
});

test("满高帧 render：输入行后 CRLF 换行、按键提示区另起一行；末行(提示区)无 CRLF", () => {
  const input: RenderLine = { text: "> Type a message...", caret: 2 };
  const hint: RenderLine = { text: "[Enter]发送 · [Esc]打断" };
  const lines: RenderLine[] = [
    ...Array.from({ length: 22 }, (_, i) => ({ text: `line${i}` })),
    input,
    hint,
  ];
  const out = capture(lines, 40, 24);
  const idx = out.lastIndexOf(input.text);
  assert.equal(
    out.slice(idx + input.text.length, idx + input.text.length + 2),
    "\r\n",
    "输入行尾须 CRLF，否则提示区与输入行同屏一行",
  );
  const hidx = out.lastIndexOf(hint.text);
  assert.equal(
    out.slice(hidx + hint.text.length),
    "\x1b[23;3H",
    "末行(提示区)无 CRLF，光标定位输入行(第23行)第3列",
  );
});

test("renderDelta 满高帧：delta=输入行+按键提示区，输入行后 CRLF、提示区后无 CRLF", () => {
  const input: RenderLine = { text: "> hello", caret: 7 };
  const hint: RenderLine = { text: "[Enter]发送" };
  const out = capture([input, hint], 40, 24, 23, true); // 输入行=23 行，提示区=24 行(底行)
  const idx = out.lastIndexOf(input.text);
  assert.equal(
    out.slice(idx + input.text.length, idx + input.text.length + 5),
    "\r\n\x1b[K",
    "输入行后 CRLF 再擦行尾",
  );
  const hidx = out.lastIndexOf(hint.text);
  assert.equal(
    out.slice(hidx + hint.text.length),
    "\x1b[K\x1b[23;8H",
    "提示区(末行)后无 CRLF，光标定位输入行第8列",
  );
});
