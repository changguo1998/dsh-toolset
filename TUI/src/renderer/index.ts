// renderer/index.ts — Renderer 公共 API：terminal + input + screen 的组装
//
// 契约见 DESIGN.md「核心接口契约」。退出生命周期归 renderer：
// close()/SIGINT/SIGTERM/uncaught 一律先恢复终端。

import { Screen, type FrameRow, serializeFrameRow } from "./screen.ts";
import type { Size } from "./screen.ts";
import {
  DEFAULT_THEME,
  THEMES,
  type ColorTheme,
  type ThemeId,
} from "./theme.ts";
import type { KeyEvent } from "./input.ts";
import { KeyDecoder } from "./input.ts";
import {
  createTerminal,
  installExitHandlers,
  type ExitResult,
} from "./terminal.ts";

export type { FrameRow, KeyEvent };
export type { FrameSegment, FrameStyle } from "./screen.ts";
export type { Size };

export interface Renderer {
  /** 整帧重绘；render 内含末尾追加的 delta 优化 */
  render(rows: FrameRow[]): void;
  /** 强制整帧重绘（绕过 delta 优化，Ctrl+L 用） */
  refresh(rows: FrameRow[]): void;
  onKey(cb: (k: KeyEvent) => void): void;
  /** 合成按键注入（无 TTY / 测试 / 脚本驱动用；不经 stdin 解码） */
  emitKey(k: KeyEvent): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  getSize(): Size;
  /** 切换主题（改变基底前景/背景与 16 色槽位映射） */
  setTheme(id: ThemeId): void;
  /** 取当前注册表某主题（id 不存在回落默认主题） */
  getTheme?(id: ThemeId): ColorTheme;
  /** 终端 bell（BEL ；声音提醒事件钩子的输出口）。可选：注入型 renderer
   *  可不实现，App 侧经 `bell?.()` 调用。 */
  bell?(): void;
  /** 恢复终端并退出事件循环 */
  close(): void;
}

export interface CreateRendererOptions {
  /** 输出注入（测试用） */
  write?: (s: string) => void;
  /** 主题注册表（main 注入配置解析结果；缺省内置 THEMES） */
  themes?: Record<ThemeId, ColorTheme>;
  /** raw mode 开关：默认 true；测试/非 TTY 可关闭 */
  rawMode?: boolean;
  /** 追加层级渲染优化开关（默认 true） */
  delta?: boolean;
  /** close() 后是否退出进程（默认 true，符合 DESIGN「退出事件循环」契约） */
  exitOnClose?: boolean;
}

export function createRenderer(opts: CreateRendererOptions = {}): Renderer {
  const terminal = createTerminal();
  const themes = opts.themes ?? THEMES;
  const screen = new Screen({ write: opts.write, themes });
  const decoder = new KeyDecoder();
  const keyCbs = new Set<(k: KeyEvent) => void>();
  const resizeCbs = new Set<(cols: number, rows: number) => void>();
  const delta = opts.delta ?? true;
  const exitOnClose = opts.exitOnClose ?? true;
  // 当前主题（序列化文本比较用；随 setTheme 同步，screen.theme 为私有）
  let theme: ColorTheme = themes[DEFAULT_THEME];
  let prevRows: FrameRow[] | null = null;
  let closed = false;

  const passToRenderSizes = (): void => {
    if (terminal.stdin.isTTY) {
      const s = terminal.getSize();
      screen.resize(s.cols, s.rows);
      for (const cb of resizeCbs) cb(s.cols, s.rows);
    }
  };

  // 键盘解码
  const onData = (chunk: Buffer): void => {
    for (const ev of decoder.feed(chunk)) for (const cb of keyCbs) cb(ev);
  };

  // 终端恢复
  const restore = (): void => {
    if (!closed) terminal.rawMode(false);
  };

  // 退出路径统一钩子：恢复终端后退出
  const detach = installExitHandlers((r: ExitResult) => {
    restore();
    if ("exitCode" in r) process.exit(r.exitCode);
    process.stderr.write(
      String((r as { injected?: unknown }).injected ?? r) + "\n",
    );
    process.exit(1);
  });

  const stdio = terminal.stdin;
  const onResizeEvt = (): void => passToRenderSizes();

  // 启动
  if (opts.rawMode !== false) terminal.rawMode(true);
  stdio.on("data", onData);
  stdio.resume();
  process.stdout.on("resize", onResizeEvt);
  process.on("beforeExit", restore);
  passToRenderSizes();

  const renderer: Renderer = {
    render(rows: FrameRow[]): void {
      if (closed) return;
      // delta 优化：与上一帧逐行比较取变化区间，只重写该区间（帧中任意位置，
      // 不限帧尾——状态栏符号/流式末行增长都只重写对应行，不清屏）
      if (delta && prevRows) {
        const { first, last } = changedRange(prevRows, rows, theme);
        if (first === -1) {
          prevRows = rows; // 画面无变化：不出报文
          return;
        }
        // 新帧比旧帧短：区间重写后清除下方残留行（ESC[J）
        screen.renderRange(
          first + 1,
          rows.slice(first, last + 1),
          rows.length < prevRows.length,
        );
        prevRows = rows;
        return;
      }
      screen.render(rows);
      prevRows = rows;
    },
    refresh(rows: FrameRow[]): void {
      if (closed) return;
      prevRows = null; // 强制走全帧 screen.render(清屏+重绘)
      this.render(rows);
    },
    onKey(cb: (k: KeyEvent) => void): void {
      keyCbs.add(cb);
    },
    emitKey(k: KeyEvent): void {
      for (const cb of keyCbs) cb(k);
    },
    onResize(cb: (cols: number, rows: number) => void): void {
      resizeCbs.add(cb);
    },
    getSize(): Size {
      return screen.getSize();
    },
    setTheme(id: ThemeId): void {
      theme = themes[id] ?? themes[DEFAULT_THEME];
      screen.setTheme(id);
      prevRows = null; // 使下一帧走全帧重绘，把新背景/调色板画满屏幕
    },
    getTheme(id: ThemeId): ColorTheme {
      return themes[id] ?? themes[DEFAULT_THEME];
    },
    bell(): void {
      screen.beep();
    },
    close(): void {
      if (closed) return;
      closed = true;
      detach(); // 移除退出钩子，防止 close 后再被信号触发
      stdio.removeListener("data", onData);
      stdio.pause(); // 对称：启动时 resume()，关闭时 pause() 释放事件循环持有
      process.stdout.removeListener("resize", onResizeEvt);
      process.removeListener("beforeExit", restore);
      screen.reset(); // 恢复终端默认 SGR，避免残留主题色
      terminal.close();
      // DESIGN：close() = 恢复终端 + 退出事件循环
      if (exitOnClose) process.exit(0);
    },
  };
  return renderer;
}

/**
 * 两帧的变化行区间（0 基，闭区间；`first === -1` = 无变化）。
 * 逐行比较至两帧较长者：行数不同时缺失侧视为「无行」，多出/缺少的行即变化行，
 * 故删除与追加都能落到区间内（区间重写 + 尾部残留清除即可收敛到新帧）。
 */
function changedRange(
  a: FrameRow[],
  b: FrameRow[],
  theme: ColorTheme,
): { first: number; last: number } {
  const max = Math.max(a.length, b.length);
  let first = -1;
  let last = -1;
  for (let i = 0; i < max; i++) {
    const x = a[i];
    const y = b[i];
    const same =
      x !== undefined && y !== undefined
        ? sameRow(x, y, theme)
        : x === undefined && y === undefined;
    if (!same) {
      if (first === -1) first = i;
      last = i;
    }
  }
  return { first, last };
}

/**
 * 两行是否相等：按「当前主题下序列化后的行文本」比较（序列化文本即最终上屏字节，
 * 内部实现不对外——SPEC.md §14）。caret 变化(纯光标移动)也阻止 delta 合并。
 */
function sameRow(x: FrameRow, y: FrameRow, theme: ColorTheme): boolean {
  if (x.caret !== y.caret) return false;
  return serializeFrameRow(x, theme) === serializeFrameRow(y, theme);
}
