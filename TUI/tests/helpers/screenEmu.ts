// tests/helpers/screenEmu.ts — 测试侧极简终端模拟器
//
// 只实现渲染层用到的控制序列（CSI H/K/J、CR、LF、SGR 与私有模式忽略），
// 用于把 Screen/Renderer 写出的报文还原成「屏幕单元格」，断言**屏幕上实际留下的
// 字形**与当前帧一致——帧正确但屏幕残留（增量重写漏擦）这类问题只能在这一层发现。

import { displayWidth } from "../../src/app/layout.ts";

export class ScreenEmu {
  /** 屏幕单元格（按显示列索引；宽字符第二格为 ""） */
  private cells: string[][];
  private row = 0;
  private col = 0;
  private pendingWrap = false;

  constructor(
    public cols: number,
    public rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => " "),
    );
  }

  /** 喂入渲染层输出报文（逐字符解析 CSI / 文本） */
  feed(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\x1b") {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z~])/.exec(s.slice(i));
        if (m) {
          const [, params = "", cmd = ""] = m;
          if (cmd === "H") {
            const [r, c] = params.split(";");
            this.row = Math.max(0, Number(r ?? 1) - 1);
            this.col = Math.max(0, Number(c ?? 1) - 1);
            this.pendingWrap = false;
          } else if (cmd === "K") {
            // 0K：从当前光标列擦到行尾（不清光标左侧，与终端一致）
            this.clearRow(this.row, this.col);
          } else if (cmd === "J") {
            // 2J：整屏擦除；0J/J：从光标擦到屏尾
            const from = params === "2" ? 0 : this.row;
            for (let r = from; r < this.rows; r++) {
              this.clearRow(r, r === this.row ? this.col : 0);
            }
          }
          i += m[0].length;
          continue;
        }
        i += 1; // 其余转义（SGR/私有模式）忽略
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        this.pendingWrap = false;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        this.row = Math.min(this.rows - 1, this.row + 1);
        i += 1;
        continue;
      }
      if (ch >= " ") {
        const w = displayWidth(ch);
        if (this.pendingWrap || this.col + w > this.cols) {
          this.row = Math.min(this.rows - 1, this.row + 1);
          this.col = 0;
          this.pendingWrap = false;
        }
        this.cells[this.row]![this.col] = ch;
        for (let k = 1; k < w; k++) this.cells[this.row]![this.col + k] = "";
        this.col += w;
        if (this.col >= this.cols) {
          this.col = this.cols - 1;
          this.pendingWrap = true;
        }
      }
      i += 1;
    }
  }

  private clearRow(r: number, from: number): void {
    for (let c = from; c < this.cols; c++) this.cells[r]![c] = " ";
  }

  /** 第 r 行屏幕文本（行尾空格裁剪；宽字符第二格不重复计入） */
  line(r: number): string {
    return (this.cells[r] ?? []).join("").replace(/\s+$/, "");
  }

  /** 第 r 行按显示列切片（from 起 width 列） */
  slice(r: number, from: number, width: number): string {
    return (this.cells[r] ?? [])
      .slice(from, from + width)
      .join("")
      .replace(/\s+$/, "");
  }

  /** 屏幕非空的行号列表（调试用） */
  inkRows(): number[] {
    const out: number[] = [];
    for (let r = 0; r < this.rows; r++) if (this.line(r) !== "") out.push(r);
    return out;
  }
}
