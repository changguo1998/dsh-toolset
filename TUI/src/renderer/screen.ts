// renderer/screen.ts — FrameRow 定义 + 帧缓冲 + 整帧重绘
//
// 写入一次性 ANSI 报文（同步输出包裹 + 清屏/定位 + 逐行带样式写出）。
// 增量由 Renderer 走 renderRange（变化区间重写），本类只负责报文组装。
// 颜色全部 manual ANSI truecolor（经 theme.ts 解析），
// 不使用 chalk：chalk 以 `39m`/`49m` 收尾复位到终端默认，浅色主题会不可读；
// 这里每个样式段都以主题基底前景/背景收尾，保证后续文本仍按主题取色。

import {
  ansiNameToHex,
  DEFAULT_THEME,
  THEMES,
  themeSgr,
  type ColorName,
  type ColorTheme,
  type ThemeId,
  hexSgr,
} from "./theme.ts";

// ---------- 终端同步输出（DEC 2026） ----------
// 报文首尾包裹 begin/end：支持的终端（kitty/iTerm2/WezTerm/Ghostty/Windows
// Terminal/tmux 3.4+ 等）会把整块更新原子呈现，消除清屏/重写之间的中间态；
// 不支持的终端按未知私有模式忽略，无损降级。
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

// ---------- 渲染期光标隐藏 ----------
// 报文执行期间隐藏硬件光标、末尾定位 caret 后再显示：避免重写过程中光标
// 在屏幕上跳动（Bubble Tea/pi 同样在渲染期间隐藏光标）。异常收尾时由 reset()
// 兜底恢复显示，防止光标永久隐藏。
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

// ---------- 行擦除口径：先擦后写 ----------
// 每行写内容前先 `ESC[K` 擦整行（写到行首时擦到行尾），**不写行尾 `ESC[K`**：
//  1) 活动区行不补齐整行（见 layout 的 PANE_TEXT_MARGIN/活动区行不补空格），新内容
//     比旧内容短或整行清空时，若只在行尾擦，旧字会留在屏幕上——新回合清空活动区后
//     「最顶上残留几行」即由此而来（Ctrl+L 全帧重绘才消失）。
//  2) 行尾 `ESC[K` 在「光标停在右缘待折行」状态下会擦到本行最后一格（整宽行会丢
//     末字）；先擦后写不存在这个风险。
const eraseBeforeWrite = "\x1b[K";

// ---------- 段级渲染契约（旧行类型已迁移完成，FrameRow 为唯一行类型） ----------

/** 段级样式：语义色名 + 字型开关。排版层唯一样式类型（规范见 SPEC.md §11.1） */
export interface FrameStyle {
  fg?: ColorName | `#${string}`;
  bg?: ColorName | `#${string}`;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

/** 行内一段：纯文本 + 段级样式（text 绝不含 ANSI，不变量 #1） */
export interface FrameSegment {
  text: string;
  style?: FrameStyle;
}

/** 一行：排版输出最小单位（段级结构与序列化契约） */
export interface FrameRow {
  segments: FrameSegment[];
  /** 输入行硬件光标停留列（0 基显示列）；仅输入行设置 */
  caret?: number;
}

/** 一次报文内要重写的单个区间：startLine（1 基）+ 该区间的新行 */
export interface RenderInterval {
  startLine: number;
  rows: FrameRow[];
}

/** 帧段 id：按屏幕行带划分（渲染层区间重写的边界，见 app/layout 的 frameSections） */
export type FrameSectionId = "top" | "status" | "footer" | "hint";

/** 帧段：屏幕行范围（0 基 startLine，lineCount 行） */
export interface FrameSection {
  id: FrameSectionId;
  startLine: number;
  lineCount: number;
}

export interface ScreenOptions {
  /** 输出流（默认 process.stdout），可注入以测试 */
  write?: (s: string) => void;
  /** 主题注册表（启动时由 main 注入配置解析结果；缺省内置 THEMES） */
  themes?: Record<ThemeId, ColorTheme>;
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
  private theme: ColorTheme;
  private themes: Record<ThemeId, ColorTheme>;
  /** 首帧是否已渲染：仅首帧做破坏性清屏（清终端既有内容），后续全帧覆盖式重写 */
  private firstRenderDone = false;

  constructor(opts: ScreenOptions = {}) {
    this.themes = opts.themes ?? THEMES;
    this.theme = this.themes[DEFAULT_THEME];
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    // 通过 ioctl 探测终端尺寸；不可用时退回 80x24
    this.cols = process.stdout.columns || 80;
    this.rows = process.stdout.rows || 24;
  }

  /** 终端 bell：向输出流写 BEL（\x07）。声音提醒事件（任务结束/等待超时）经此输出。
   *  保持与画面渲染同一输出出口（可注入 write 捕获/转发）。 */
  beep(): void {
    this.write("\x07");
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  getSize(): Size {
    return { cols: this.cols, rows: this.rows };
  }

  setTheme(id: ThemeId): void {
    this.theme = this.themes[id] ?? this.themes[DEFAULT_THEME];
  }

  /**
   * 整帧重绘：定位原点 → 逐行(基底色 + **先擦整行** + 样式覆盖) → 清除下方
   * 残留 → 末尾光标回到输入行。**仅首帧**做一次破坏性清屏（清掉终端既有内容）；
   * 后续全帧（resize/主题切换/Ctrl+L）不再 `ESC[2J`——清屏与重写之间的中间态
   * 正是可见闪烁的来源（见 Codewhale 去 2J 修复、Bubble Tea/pi 的常规帧不清屏）。
   *
   * 擦除口径见 `eraseBeforeWrite` 注释：**每行先擦后写**，不写行尾 `ESC[K`。
   */
  render(rows: FrameRow[]): void {
    const base = baseSgr(this.theme); // 主题基底前景+背景
    const out: string[] = [SYNC_BEGIN, CURSOR_HIDE]; // 同步开始 + 渲染期隐藏光标
    if (!this.firstRenderDone) {
      // 首帧：基底色先于清屏写出（ESC[2J 以当前主题背景填充整屏）
      out.push(base + "\x1b[2J\x1b[H");
      this.firstRenderDone = true;
    } else {
      // 全帧重写：绝对定位原点，逐行覆盖（不依赖清屏）
      out.push(base + "\x1b[1;1H");
    }
    let caret: { row: number; col: number } | null = null; // 输入行光标(0 基列)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      // 每行前缀主题基底色：行内样式段只改前景/背景并恢复到主题基底，
      // 但 bold 用 22m 收尾可能留下中间态，统一每行重设基底最稳妥
      out.push(base + eraseBeforeWrite + serializeFrameRow(row, this.theme));
      if (row.caret !== undefined) {
        // 输入行仅记录硬件光标停留列；换行统一由「末行不写 CRLF」规则管理
        caret = { row: i + 1, col: row.caret };
      }
      // 仅末行不写尾部 CRLF：满高帧时末行 CRLF 触发触底上滚，下方多出一整行、
      // 硬件光标落在显示内容下方一行；光标由末尾转义精确定位。
      // （按键提示区加入后输入行不再占末行、须 CRLF 换行；此前无 caret 行的
      // 面板帧末行会写 CRLF 同样触底上滚 1 行，此处一并修正）
      if (i < rows.length - 1) out.push("\r\n");
    }
    // 清除帧下方可能残留的旧行（尺寸/行数变化时）：定位到**帧下一行行首**再
    // `ESC[J` 擦到屏尾。不在末行行尾就地 `ESC[J`——末行写满整行时（状态栏/提示区
    // 等）光标停在右缘「待折行」状态，此处 ESC[J 会连带擦掉末行最后一格。
    const below = rows.length + 1;
    if (below <= this.rows) out.push(`\x1b[${below};1H\x1b[J`);
    // 光标必须在所有行写完后再移动，否则后续行从光标列起写
    if (caret) out.push(`\x1b[${caret.row};${caret.col + 1}H`);
    out.push(CURSOR_SHOW); // 定位完成后再显示光标（无 caret 时同样保持可见）
    out.push(SYNC_END); // 同步结束：终端原子呈现整帧
    this.write(out.join(""));
  }

  /**
   * 多区间重写：一次报文内更新多个**不连续**区间（各自绝对定位 + **先擦整行**），
   * 末尾统一清残留（`clearBelow`）并定位光标。用于按帧段切分的变化区间——
   * 多段同时变化时只重写各段内的变化行，不跨越中间未变化的段。
   *
   * 擦除口径见 `eraseBeforeWrite` 注释。
   */
  renderRanges(intervals: RenderInterval[], clearBelow = false): void {
    const out: string[] = [SYNC_BEGIN, CURSOR_HIDE]; // 同步开始 + 渲染期隐藏光标
    const base = baseSgr(this.theme); // 主题基底前景+背景（ESC[K 按当前背景填充）
    let caret: { row: number; col: number } | null = null; // 输入行光标(0 基列)
    let lastLine = 0; // 已写内容的最末行（1 基；残留清除起点据此推算）
    for (const iv of intervals) {
      if (iv.rows.length === 0) continue;
      // 绝对定位到区间首行（不依赖前一区间的落点）
      out.push(`\x1b[${iv.startLine};1H`);
      for (let i = 0; i < iv.rows.length; i++) {
        const row = iv.rows[i]!;
        // 先擦整行再写：活动区行不补齐整行，新内容变短/变空时必须擦掉旧字
        out.push(base + eraseBeforeWrite + serializeFrameRow(row, this.theme));
        if (row.caret !== undefined) {
          caret = { row: iv.startLine + i, col: row.caret };
        }
        // 非末行 CRLF 换行、末行省略 CRLF（防满高帧触底上滚）
        if (i < iv.rows.length - 1) out.push("\r\n");
      }
      lastLine = Math.max(lastLine, iv.startLine + iv.rows.length - 1);
    }
    if (clearBelow) {
      // 残留首行（1 基）：无任何区间写入时取首区间起点
      const first = intervals[0]?.startLine ?? 1;
      const clearLine = lastLine > 0 ? lastLine + 1 : first;
      if (clearLine <= this.rows) out.push(`\x1b[${clearLine};1H\x1b[J`);
    }
    // 光标必须在所有行写完后再移动，否则后续行从光标列起写
    if (caret) out.push(`\x1b[${caret.row};${caret.col + 1}H`);
    out.push(CURSOR_SHOW); // 定位完成后再显示光标
    out.push(SYNC_END); // 同步结束：终端原子呈现本批区间更新
    this.write(out.join(""));
  }

  /** 单区间重写（renderRanges 的特例） */
  renderRange(startLine: number, rows: FrameRow[], clearBelow = false): void {
    this.renderRanges([{ startLine, rows }], clearBelow);
  }

  /** 只重绘末尾追加的 delta 行：等价于「区间重写」的帧尾特例 */
  renderDelta(startLine: number, rows: FrameRow[]): void {
    this.renderRange(startLine, rows);
  }

  /** 恢复终端默认样式（关闭前调用，避免残留主题色） */
  reset(): void {
    // 补发同步结束与光标显示：进程若在同步块/隐藏光标状态下异常收尾，
    // 防止终端保持「不刷新」或光标永久隐藏
    this.write(SYNC_END + CURSOR_SHOW + "\x1b[0m");
  }
}

/** 主题基底色 SGR 前缀（前景+背景） */
function baseSgr(theme: ColorTheme): string {
  return themeSgr(theme, true) + themeSgr(theme, false);
}

// ---------- 段级序列化 ----------

/** 两段样式是否全字段相等（相邻合并判定） */
function sameFrameStyle(
  a: FrameStyle | undefined,
  b: FrameStyle | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike
  );
}

/** 单段样式 → manual ANSI open/close（未知名色名回退基底；#hex 直接使用） */
function segSgr(
  seg: FrameSegment,
  theme: ColorTheme,
): { open: string; close: string } {
  const st = seg.style;
  const open: string[] = [];
  const close: string[] = [];
  if (st?.bold) {
    open.push("\x1b[1m");
    close.push("\x1b[22m");
  }
  if (st?.italic) {
    open.push("\x1b[3m");
    close.push("\x1b[23m");
  }
  if (st?.underline) {
    open.push("\x1b[4m");
    close.push("\x1b[24m");
  }
  if (st?.strike) {
    open.push("\x1b[9m");
    close.push("\x1b[29m");
  }
  if (st?.fg) {
    const hex = st.fg.startsWith("#") ? st.fg : ansiNameToHex(theme, st.fg);
    if (hex) {
      open.push(hexSgr(hex, true));
      close.push(hexSgr(theme.foreground, true));
    }
  }
  if (st?.bg) {
    const hex = st.bg.startsWith("#") ? st.bg : ansiNameToHex(theme, st.bg);
    if (hex) {
      open.push(hexSgr(hex, false));
      close.push(hexSgr(theme.background, false));
    }
  }
  return { open: open.join(""), close: close.reverse().join("") };
}

/**
 * 单段序列化为 manual ANSI（open + text + close；无样式仅返回文本）。
 * 相邻同 style 合并由 serializeFrameRow 负责（SPEC.md §14）。
 */
export function segStyle(seg: FrameSegment, theme: ColorTheme): string {
  const st = seg.style;
  if (!st) return seg.text;
  const { open, close } = segSgr(seg, theme);
  if (!open && !close) return seg.text;
  return open + seg.text + close;
}

/** 整行序列化：相邻同 style 合并（只输出一次前缀）、异 style 时关闭前段再开新段、
 * 行尾 SGR 重置（样式关闭）。等价于逐段 styleLine，但相邻同 style 不重复 open/close。 */
export function serializeFrameRow(row: FrameRow, theme: ColorTheme): string {
  let out = "";
  let lastStyle: FrameStyle | undefined;
  const close = (): void => {
    if (lastStyle !== undefined)
      out += segSgr({ text: "", style: lastStyle }, theme).close;
  };
  for (const seg of row.segments) {
    const st = seg.style;
    if (st !== undefined && sameFrameStyle(st, lastStyle)) {
      // 与上一段同 style：合并，不再开前缀
    } else {
      if (st !== undefined) {
        close(); // 关闭前一段样式
        out += segSgr(seg, theme).open;
      } else {
        close(); // 转普通文本：关闭前一段样式
      }
    }
    out += seg.text;
    lastStyle = st;
  }
  close(); // 行尾 SGR 重置
  return out;
}
