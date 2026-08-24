// renderer/screen.ts — RenderLine 定义 + 帧缓冲 + 整帧重绘
//
// 写入一次性 ANSI 报文（清屏 + 光标回到原点 + 逐行带样式写出）。
// 无 diff：每次 render 整帧重绘。`ponytail:` 无 diff，行数大若有闪烁
// 再引入增量渲染。

import chalk from "chalk";

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

  /** 整帧重绘：清屏 → 原点 → 每行样式化输出 → 末尾光标回到输入行 */
  render(lines: RenderLine[]): void {
    const out: string[] = ["\x1b[2J\x1b[H"]; // 清屏 + 光标回原点
    let caret: { row: number; col: number } | null = null; // 输入行光标(0 基列)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      out.push(styleLine(line));
      if (line.caret !== undefined) {
        // 输入行不加尾部 \r\n：满高帧时为最后一行，CRLF 触发触底上滚，
        // 使下方多出一整行、光标落在输入行下一行。光标由末尾转义精确定位。
        caret = { row: i + 1, col: line.caret };
      } else {
        out.push("\r\n");
      }
    }
    // 光标必须在所有行写完后再移动，否则后续行从光标列起写
    if (caret) out.push(`\x1b[${caret.row};${caret.col + 1}H`);
    this.write(out.join(""));
  }

  /** 只重绘末尾追加的 delta 行（render 的最后一行优化）：移动到 delta 起始行后写出行 */
  renderDelta(startLine: number, lines: RenderLine[]): void {
    const out: string[] = [];
    const height = Math.max(1, this.rows);
    // 光标移动到 startLine（1 基数）
    out.push(`\x1b[${startLine};1H`);
    let caret: { row: number; col: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      out.push(styleLine(line));
      if (line.caret !== undefined) {
        // 输入行：仅擦除行尾残留，不回车换行(避免满高帧触底上滚后光标偏下一行)
        out.push("\x1b[K");
        caret = { row: startLine + i, col: line.caret };
      } else {
        out.push("\r\n\x1b[K"); // 每行写完后擦除到行尾，避免残留上一帧更长的旧字符
      }
    }
    if (caret) out.push(`\x1b[${caret.row};${caret.col + 1}H`);
    this.write(out.join(""));
    void height;
  }
}

/** 按每个字符应用样式；无色/无粗体则原样返回。 */
export function styleLine(line: RenderLine): string {
  const { text } = line;
  const st = line.style;
  if (!st) return text;
  let out = text;
  let colored = false;
  if (st.bold) out = chalk.bold(out);
  if (st.fg) {
    const fn = pickColor(st.fg);
    if (fn) {
      out = fn(out);
      colored = true;
    }
  }
  if (st.bg) {
    const fn = pickColor(st.bg);
    if (fn) {
      if (colored) out = fn(out);
      else out = fn(out);
    }
  }
  return out;
}

/** 常用 16 色名 → chalk 函数；不认识的颜色名原样返回（不抛异常） */
function pickColor(name: string): ((s: string) => string) | null {
  const map: Record<string, (s: string) => string> = {
    black: chalk.black,
    red: chalk.red,
    green: chalk.green,
    yellow: chalk.yellow,
    blue: chalk.blue,
    magenta: chalk.magenta,
    cyan: chalk.cyan,
    white: chalk.white,
    gray: chalk.gray,
    brightBlack: chalk.blackBright,
    brightRed: chalk.redBright,
    brightGreen: chalk.greenBright,
    brightYellow: chalk.yellowBright,
    brightBlue: chalk.blueBright,
    brightMagenta: chalk.magentaBright,
    brightCyan: chalk.cyanBright,
    brightWhite: chalk.whiteBright,
  };
  return map[name.toLowerCase()] ?? null;
}
