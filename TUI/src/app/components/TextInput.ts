// src/app/components/TextInput.ts — 输入行渲染（纯函数）
//
// 渲染 input 文本 + 光标（以反色块表示）。光标通过 ANSI 反相显示
// 由 renderer 输出，这里生成带标记的文本行。

import type { RenderLine } from "../../renderer/index.ts";

/**
 * 生成输入行。cursor 为文本内光标位置（0..text.length）。
 * width 为终端列宽（超宽输入做水平滚动保留光标可见——见 hshift）。
 */
export function renderTextInput(
  text: string,
  cursor: number,
  placeholder: string,
  width: number,
): RenderLine[] {
  const prompt = "❯ ";
  const avail = Math.max(1, width - prompt.length);
  let hshift = 0;
  if (text.length > avail) {
    // 光标可见性：保持光标在窗口内
    if (cursor < hshift) hshift = cursor;
    else if (cursor > hshift + avail - 1) hshift = cursor - (avail - 1);
    hshift = Math.max(0, Math.min(hshift, text.length - avail));
  }
  const visible = text.slice(hshift, hshift + avail);
  let display = "";
  for (let i = 0; i < visible.length; i++) {
    const ch = visible[i]!;
    const isCursor = hshift + i === cursor;
    display += isCursor ? `\x1b[7m${ch}\x1b[27m` : ch;
  }
  if (display === "") display = placeholder;
  const ret: RenderLine[] = [{ text: prompt + display }];
  return ret;
}
