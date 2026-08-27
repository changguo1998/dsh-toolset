// renderer/screen.ts — RenderLine 定义 + 帧缓冲 + 整帧重绘
//
// 写入一次性 ANSI 报文（清屏 + 光标回到原点 + 逐行带样式写出）。
// 无 diff：每次 render 整帧重绘。`ponytail:` 无 diff，行数大若有闪烁
// 再引入增量渲染。颜色全部 manual ANSI truecolor（经 theme.ts 解析），
// 不使用 chalk：chalk 以 `39m`/`49m` 收尾复位到终端默认，浅色主题会不可读；
// 这里每个样式段都以主题基底前景/背景收尾，保证后续文本仍按主题取色。

import {
  ansiNameToHex,
  DEFAULT_THEME,
  THEMES,
  themeSgr,
  type ColorTheme,
  type ThemeId,
  hexSgr,
} from "./theme.ts";

export interface RenderLine {
  text: string;
  style?: { fg?: string; bg?: string; bold?: boolean };
  /** 渲染后硬件光标停留的显示列(0 基)；仅输入行设置(TextInput 计算) */
  caret?: number;
}

export interface ScreenOptions {
  /** 输出流（默认 process.stdout），可注入以测试 */
  write?: (s: string) => void;
}

/** 屏幕尺寸 */
export interface Size {
  cols: number;
  rows: number;
}

export class Screen {
  private write: (s: string) => void;
  private cols: number;
  private rows: number;
  private theme: ColorTheme = THEMES[DEFAULT_THEME];

  constructor(opts: ScreenOptions = {}) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    // 通过 ioctl 探测终端尺寸；不可用时退回 80x24
    this.cols = process.stdout.columns || 80;
    this.rows = process.stdout.rows || 24;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  getSize(): Size {
    return { cols: this.cols, rows: this.rows };
  }

  setTheme(id: ThemeId): void {
    this.theme = THEMES[id];
  }

  /** 整帧重绘：清屏 → 原点 → 每行(基底色+样式)输出 → 末尾光标回到输入行 */
  render(lines: RenderLine[]): void {
    const base = baseSgr(this.theme); // 主题基底前景+背景
    // 基底色先于清屏写出：ESC[2J 以当前(主题)背景填充整屏；后续每行再补
    // 基底色以覆盖行内样式段收尾后恢复到主题基底（不依赖 chalk 复位）
    const out: string[] = [base + "\x1b[2J\x1b[H"]; // 基底色 + 清屏 + 光标回原点
    let caret: { row: number; col: number } | null = null; // 输入行光标(0 基列)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // 每行前缀主题基底色：行内样式段只改前景/背景并恢复到主题基底，
      // 但 bold 用 22m 收尾可能留下中间态，统一每行重设基底最稳妥
      out.push(base + styleLine(line, this.theme));
      if (line.caret === undefined) {
        out.push("\r\n");
      } else {
        // 输入行不加尾部 \r\n：满高帧时为最后一行，CRLF 触发触底上滚，
        // 使下方多出一整行、光标落在输入行下一行。光标由末尾转义精确定位。
        caret = { row: i + 1, col: line.caret };
      }
    }
    // 光标必须在所有行写完后再移动，否则后续行从光标列起写
    if (caret) out.push(`\x1b[${caret.row};${caret.col + 1}H`);
    this.write(out.join(""));
  }

  /** 只重绘末尾追加的 delta 行：移动到 delta 起始行后、以主题基底色写出行 */
  renderDelta(startLine: number, lines: RenderLine[]): void {
    const out: string[] = [];
    // 光标移动到 startLine（1 基数）
    out.push(`\x1b[${startLine};1H`);
    let caret: { row: number; col: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // ESC[K 擦除以当前 bg 填充，故每个 delta 行都要带主题基底色
      out.push(baseSgr(this.theme) + styleLine(line, this.theme));
      if (line.caret === undefined) {
        out.push("\r\n\x1b[K"); // 每行写完后擦除到行尾，避免残留上一帧更长的旧字符
      } else {
        // 输入行：仅擦除行尾残留，不回车换行(避免满高帧触底上滚后光标偏下一行)
        out.push("\x1b[K");
        caret = { row: startLine + i, col: line.caret };
      }
    }
    if (caret) out.push(`\x1b[${caret.row};${caret.col + 1}H`);
    this.write(out.join(""));
  }

  /** 恢复终端默认样式（关闭前调用，避免残留主题色） */
  reset(): void {
    this.write("\x1b[0m");
  }
}

/** 主题基底色 SGR 前缀（前景+背景） */
function baseSgr(theme: ColorTheme): string {
  return themeSgr(theme, true) + themeSgr(theme, false);
}

/**
 * 按每个字符应用样式：manual ANSI，前景/背景分别以 38;2 / 48;2 设置，
 * bold 以 `1m` 开头 `22m` 收尾；无样式则原样返回。
 */
export function styleLine(line: RenderLine, theme: ColorTheme): string {
  const { text } = line;
  const st = line.style;
  if (!st) return text;
  const open: string[] = [];
  const close: string[] = [];
  if (st.bold) {
    open.push("\x1b[1m");
    close.push("\x1b[22m");
  }
  if (st.fg) {
    const hex = ansiNameToHex(theme, st.fg);
    if (hex) {
      open.push(hexSgr(hex, true));
      close.push(hexSgr(theme.foreground, true));
    }
  }
  if (st.bg) {
    const hex = ansiNameToHex(theme, st.bg);
    if (hex) {
      open.push(hexSgr(hex, false));
      close.push(hexSgr(theme.background, false));
    }
  }
  if (open.length === 0 && close.length === 0) return text;
  return open.join("") + text + close.reverse().join("");
}
