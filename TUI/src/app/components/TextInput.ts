// src/app/components/TextInput.ts — 输入行渲染（纯函数）
//
// 渲染 input 文本 + 光标位置。光标不在文本里画反色块，而是返回 caret(显示列)
// 由 Screen 把硬件光标移动到该列——保证可见光标与真实输入位置一致(含 CJK 宽度)。
// 输出 RenderLine 带 caret 字段(列，0 基)；超宽输入做水平滚动保留光标可见(hshift 按显示列)。

import type { RenderLine } from "../../renderer/index.ts";
import { displayWidth, charWidth } from "../layout.ts";

/**
 * 生成输入行。cursor 为文本内光标位置(0..text.length，按 code point)。
 * width 为终端列宽(超宽输入做水平滚动保留光标可见——见 hshift)。
 * 返回行附带 caret=光标显示列(0 基)，供 Screen 移动硬件光标。
 */
export function renderTextInput(
  text: string,
  cursor: number,
  placeholder: string,
  width: number,
): RenderLine[] {
  const prompt = "❯ ";
  const promptWidth = displayWidth(prompt); // "❯ " = ❯(2)+space(1)
  const avail = Math.max(1, width - promptWidth); // 输入区可用列数

  // 按 code point 拆开并计算各自显示宽度
  const chars = Array.from(text);
  const widths = chars.map((c) => charWidth(c));
  const total = widths.reduce((a, b) => a + b, 0);
  const pos = Math.max(0, Math.min(cursor, chars.length));
  // 光标之前各字的显示宽度和 = 光标显示列(相对输入区起点)
  let cursorCol = 0;
  for (let i = 0; i < pos; i++) cursorCol += widths[i] ?? 0;

  // 水平滚动：保持光标显示列在可视窗口 [0, avail) 内
  let hshift = 0;
  if (total > avail) {
    if (cursorCol < hshift) hshift = cursorCol;
    else if (cursorCol > hshift + avail - 1) hshift = cursorCol - (avail - 1);
    hshift = Math.max(0, Math.min(hshift, total - avail));
  }

  // 组装可见文本 + 光标列
  let display = "";
  let col = 0; // 当前字符相对输入区起点的显示列
  let caret = cursorCol - hshift; // 相对输入区起点，稍后加 promptWidth
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const w = widths[i]!;
    if (col >= hshift && col < hshift + avail) display += ch;
    col += w;
  }
  if (display === "") display = placeholder;
  return [{ text: prompt + display, caret: promptWidth + caret }];
}
