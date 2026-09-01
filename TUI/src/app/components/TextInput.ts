// src/app/components/TextInput.ts — 输入区渲染（纯函数）
//
// 渲染输入框（可多行）+ 光标位置。光标不在文本里画反色块，而是返回 caret(显示列)
// 由 Screen 把硬件光标移动到该列——保证可见光标与真实输入位置一致(含 CJK 宽度)。
// 多行：文本按 avail 显示列换行（续行与首行文本起点对齐，缩进 promptWidth），
// 顶部对齐，光标行超出区域高度时整体下移跟随（vshift），文本之外的行留空。

import type { RenderLine } from "../../renderer/index.ts";
import { displayWidth, charWidth } from "../layout.ts";

/**
 * 生成输入区（height 行）。cursor 为文本内光标位置(0..text.length，按 code point)。
 * width 为终端列宽；promptText 为显示前缀（如两字符提示 "✓> "，可携带分段 ANSI
 * 着色，默认 "> "）；promptColor 可选对整体着色；宽度始终按未着色纯文本经
 * displayWidth 计算（ANSI 序列不占列）。
 *
 * 文本按 avail = width - promptWidth 列统一换行（字符不跨行，不切半个 CJK）：
 * 首行带 prompt，续行缩进 promptWidth 列；光标所在行超出可见范围时按 vshift
 * 整体滚动跟随。输出各行附带 caret=光标显示列(0 基，仅光标所在行设置)，
 * 供 Screen 移动硬件光标。
 */
export function renderTextInput(
  text: string,
  cursor: number,
  placeholder: string,
  width: number,
  promptText = "> ",
  promptColor?: (s: string) => string,
  height = 1,
): RenderLine[] {
  // prompt 可带 ANSI 着色，宽度按未着色纯文本算，避免把转义序列计进显示宽度
  const prompt = promptColor ? promptColor(promptText) : promptText;
  const promptWidth = displayWidth(promptText);
  const avail = Math.max(1, width - promptWidth);
  const boxHeight = Math.max(1, height);

  // 按 code point 拆开并计算各自显示宽度
  const chars = Array.from(text);
  const widths = chars.map((c) => charWidth(c));
  const pos = Math.max(0, Math.min(cursor, chars.length));
  // 光标之前各字的显示宽度和 = 光标在文本流中的绝对列
  let cursorFlowCol = 0;
  for (let i = 0; i < pos; i++) cursorFlowCol += widths[i] ?? 0;

  // 换行：每行至多 avail 显示列，字符将跨行末时先断行（不切半个 CJK）
  const rows: string[][] = [];
  let cur: string[] = [];
  let col = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const w = widths[i]!;
    if (cur.length > 0 && col + w > avail) {
      rows.push(cur);
      cur = [];
      col = 0;
    }
    cur.push(ch);
    col += w;
  }
  rows.push(cur);

  // 光标行/列：第 k 行覆盖流列 [k*avail, (k+1)*avail)；
  // 光标可能落在文本结束后的空行（恰在换行边界/文本末尾）
  const cursorRow = Math.floor(cursorFlowCol / avail);
  const colInRow = cursorFlowCol - cursorRow * avail;
  const contentRows = Math.max(rows.length, cursorRow + 1);

  // 垂直滚动：保持光标行在可见窗口 [vshift, vshift+boxHeight) 内
  let vshift = 0;
  if (cursorRow > vshift + boxHeight - 1) vshift = cursorRow - (boxHeight - 1);
  vshift = Math.max(0, Math.min(vshift, Math.max(0, contentRows - 1)));

  // 组装可见行：首行带 prompt，续行缩进对齐，文本之外的行留空
  const out: RenderLine[] = [];
  for (let i = 0; i < boxHeight; i++) {
    const r = vshift + i;
    const isCursorRow = r === cursorRow;
    if (r === 0) {
      if (chars.length === 0) {
        out.push({ text: prompt + placeholder, caret: promptWidth });
      } else {
        out.push({
          text: prompt + rows[0]!.join(""),
          caret: isCursorRow ? promptWidth + colInRow : undefined,
        });
      }
    } else if (r < rows.length) {
      out.push({
        text: " ".repeat(promptWidth) + rows[r]!.join(""),
        caret: isCursorRow ? promptWidth + colInRow : undefined,
      });
    } else {
      // 留空行（含文本恰在换行边界时光标所在的空行）
      out.push({
        text: "",
        caret: isCursorRow ? promptWidth + colInRow : undefined,
      });
    }
  }
  return out;
}
