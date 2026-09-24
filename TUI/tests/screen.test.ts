// tests/screen.test.ts — Screen 帧写出（光标定位）单测
//
// REGRESSION: 满高帧下 input 行为最后一行，旧实现尾部 CRLF 触发触底上滚，
// 硬件光标落在输入行下一行(与显示不符)。修复后尾部只跟定位转义（擦除改为
// 「每行先擦后写」，见 Screen 的 eraseBeforeWrite）。
// 按键提示区另起一行、输入行不占末行：统一规则「仅帧末行不写 CRLF」，
// 保证提示区另起一行；并修掉无 caret 行的面板帧末行 CRLF 的触底上滚 1 行问题。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen, type FrameRow } from "../src/renderer/screen.ts";
import { rowText } from "./helpers/rowText.ts";

function capture(
  lines: FrameRow[],
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
  const footer: FrameRow = {
    segments: [{ text: "> Type a message..." }],
    caret: 2,
  };
  const lines: FrameRow[] = [
    ...Array.from({ length: 23 }, (_, i) => ({
      segments: [{ text: `line${i}` }],
    })),
    footer,
  ];
  const out = capture(lines, 40, 24);
  // 输入行文本之后必须是定位转义，不能有 \r\n(避免触底上滚)
  const idx = out.lastIndexOf(rowText(footer));
  assert.ok(idx >= 0, "输出应包含输入行");
  assert.ok(
    !out.slice(idx + rowText(footer).length).includes("\r\n"),
    "输入行尾不得有 CRLF",
  );
  assert.equal(
    out.slice(idx + rowText(footer).length),
    "\x1b[24;3H\x1b[?25h\x1b[?2026l",
    "满高帧末行后直接定位到第24行第3列（下方无残留需清；擦除在行首完成）",
  );
});

test("非满高帧 render：普通行保留 CRLF，输入行仍定位正确", () => {
  const footer: FrameRow = {
    segments: [{ text: "> Type a message..." }],
    caret: 2,
  };
  const out = capture([{ segments: [{ text: "header" }] }, footer], 40, 24);
  const idx = out.lastIndexOf(rowText(footer));
  assert.equal(
    out.slice(idx + rowText(footer).length),
    "\x1b[3;1H\x1b[J\x1b[2;3H\x1b[?25h\x1b[?2026l",
    "帧下一行行首 ESC[J 清残留，再定位光标到第2行第3列",
  );
  assert.ok(out.includes("header\r\n"), "普通行保留 CRLF");
});

test("renderDelta 满高帧：startLine+i 为末行时输入行不 CRLF，光标仍在输入行", () => {
  const footer: FrameRow = { segments: [{ text: "> hello" }], caret: 7 };
  const out = capture([footer], 40, 24, 24, true); // startLine=24，即最后一行
  const idx = out.lastIndexOf(rowText(footer));
  const tail = out.slice(idx + rowText(footer).length);
  assert.ok(!tail.includes("\r\n"), "delta 输入行尾不得有 CRLF(避免触底上滚)");
  assert.equal(
    tail,
    "\x1b[24;8H\x1b[?25h\x1b[?2026l",
    "定位到第24行第8列（擦除已在行首完成，行尾不再补 ESC[K）",
  );
});

test("renderDelta 非满高帧：输入行写内容后定位，位置正确", () => {
  const footer: FrameRow = { segments: [{ text: "> ab" }], caret: 4 };
  const out = capture(
    [{ segments: [{ text: "scrolled" }] }, footer],
    40,
    24,
    5,
    true,
  );
  const idx = out.lastIndexOf(rowText(footer));
  const tail = out.slice(idx + rowText(footer).length);
  assert.equal(
    tail,
    "\x1b[6;5H\x1b[?25h\x1b[?2026l",
    "输入行在 delta 中为一行内容 + 定位",
  );
});

test("满高帧 render：输入行后 CRLF 换行、按键提示区另起一行；末行(提示区)无 CRLF", () => {
  const input: FrameRow = {
    segments: [{ text: "> Type a message..." }],
    caret: 2,
  };
  const hint: FrameRow = { segments: [{ text: "[Enter]发送 · [Esc]打断" }] };
  const lines: FrameRow[] = [
    ...Array.from({ length: 22 }, (_, i) => ({
      segments: [{ text: `line${i}` }],
    })),
    input,
    hint,
  ];
  const out = capture(lines, 40, 24);
  const idx = out.lastIndexOf(rowText(input));
  assert.equal(
    out.slice(idx + rowText(input).length, idx + rowText(input).length + 2),
    "\r\n",
    "输入行尾须 CRLF，否则提示区与输入行同屏一行",
  );
  const hidx = out.lastIndexOf(rowText(hint));
  assert.equal(
    out.slice(hidx + rowText(hint).length),
    "\x1b[23;3H\x1b[?25h\x1b[?2026l",
    "末行(提示区)无 CRLF，光标定位输入行(第23行)第3列",
  );
});

test("renderDelta 满高帧：delta=输入行+按键提示区，输入行后 CRLF、提示区后无 CRLF", () => {
  const input: FrameRow = { segments: [{ text: "> hello" }], caret: 7 };
  const hint: FrameRow = { segments: [{ text: "[Enter]发送" }] };
  const out = capture([input, hint], 40, 24, 23, true); // 输入行=23 行，提示区=24 行(底行)
  const idx = out.lastIndexOf(rowText(input));
  assert.equal(
    out.slice(idx + rowText(input).length, idx + rowText(input).length + 2),
    "\r\n",
    "输入行后 CRLF 换行",
  );
  const hidx = out.lastIndexOf(rowText(hint));
  assert.equal(
    out.slice(hidx + rowText(hint).length),
    "\x1b[23;8H\x1b[?25h\x1b[?2026l",
    "提示区(末行)后无 CRLF，光标定位输入行第8列",
  );
});

test("同步输出：整帧与区间报文均以 DEC 2026 begin/end 成对包裹", () => {
  const full = capture([{ segments: [{ text: "x" }] }], 40, 24);
  assert.ok(full.startsWith("\x1b[?2026h"), "整帧报文以同步开始包裹");
  assert.ok(full.endsWith("\x1b[?25h\x1b[?2026l"), "整帧报文以同步结束收尾");
  const range = capture([{ segments: [{ text: "y" }] }], 40, 24, 3, true);
  assert.ok(range.startsWith("\x1b[?2026h"), "区间报文以同步开始包裹");
  assert.ok(range.endsWith("\x1b[?25h\x1b[?2026l"), "区间报文以同步结束收尾");
});

test("全帧重写：仅首帧清屏，后续全帧覆盖式重写（无 ESC[2J）", () => {
  const writes: string[] = [];
  const screen = new Screen({ write: (x) => writes.push(x) });
  screen.resize(40, 24);
  const frame = (text: string): FrameRow[] => [
    { segments: [{ text }] },
    { segments: [{ text: "> input" }], caret: 2 },
  ];
  screen.render(frame("first"));
  assert.ok(writes[0]!.includes("\x1b[2J"), "首帧清屏一次（清终端既有内容）");
  writes.length = 0;
  screen.render(frame("second"));
  const out = writes.join("");
  assert.ok(!out.includes("\x1b[2J"), "后续全帧不得清屏（闪烁来源）");
  assert.ok(out.includes("\x1b[1;1H"), "应绝对定位原点覆盖重写");
  assert.ok(out.includes("\x1b[J"), "应清除下方残留旧行");
  assert.ok(out.includes("second"), "应写入新内容");
  assert.ok(out.includes("\x1b[K"), "每行先擦后写（行首 ESC[K，不依赖清屏）");
});

test("光标管理：报文渲染期隐藏、定位 caret 后显示；reset 兜底恢复显示", () => {
  const writes: string[] = [];
  const screen = new Screen({ write: (x) => writes.push(x) });
  screen.resize(40, 24);
  screen.render([{ segments: [{ text: "> x" }], caret: 3 }]);
  const out = writes.join("");
  assert.ok(out.startsWith("\x1b[?2026h\x1b[?25l"), "报文开头隐藏光标");
  assert.ok(out.includes("\x1b[1;4H\x1b[?25h"), "定位 caret 后再显示光标");
  writes.length = 0;
  screen.reset();
  assert.ok(
    writes.join("").includes("\x1b[?25h"),
    "reset 兜底恢复光标显示（防异常收尾永久隐藏）",
  );
});
