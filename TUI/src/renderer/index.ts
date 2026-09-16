// renderer/index.ts — Renderer 公共 API：terminal + input + screen 的组装
//
// 契约见 DESIGN.md「核心接口契约」。退出生命周期归 renderer：
// close()/SIGINT/SIGTERM/uncaught 一律先恢复终端。

import { Screen, type FrameRow, serializeFrameRow } from "./screen.ts";
import type { Size } from "./screen.ts";
import { DEFAULT_THEME, THEMES, type ColorTheme, type ThemeId } from "./theme.ts";
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
  /** 恢复终端并退出事件循环 */
  close(): void;
}

export interface CreateRendererOptions {
  /** 输出注入（测试用） */
  write?: (s: string) => void;
  /** raw mode 开关：默认 true；测试/非 TTY 可关闭 */
  rawMode?: boolean;
  /** 追加层级渲染优化开关（默认 true） */
  delta?: boolean;
  /** close() 后是否退出进程（默认 true，符合 DESIGN「退出事件循环」契约） */
  exitOnClose?: boolean;
}

export function createRenderer(opts: CreateRendererOptions = {}): Renderer {
  const terminal = createTerminal();
  const screen = new Screen({ write: opts.write });
  const decoder = new KeyDecoder();
  const keyCbs = new Set<(k: KeyEvent) => void>();
  const resizeCbs = new Set<(cols: number, rows: number) => void>();
  const delta = opts.delta ?? true;
  const exitOnClose = opts.exitOnClose ?? true;
  // 当前主题（序列化文本比较用；随 setTheme 同步，screen.theme 为私有）
  let theme: ColorTheme = THEMES[DEFAULT_THEME];
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
      // delta 优化：与上一帧共用前缀，仅末尾变化/追加 → 只写 delta
      if (delta && prevRows) {
        const prefix = commonPrefix(prevRows, rows, theme);
        if (prefix >= prevRows.length) {
          screen.renderDelta(prefix + 1, rows.slice(prefix));
          prevRows = rows;
          return;
        }
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
      theme = THEMES[id];
      screen.setTheme(id);
      prevRows = null; // 使下一帧走全帧重绘，把新背景/调色板画满屏幕
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

/** 两帧 FrameRow 从头部起相同前缀的行数 */
function commonPrefix(a: FrameRow[], b: FrameRow[], theme: ColorTheme): number {
  let n = 0;
  while (n < a.length && n < b.length && sameRow(a[n]!, b[n]!, theme)) n++;
  return n;
}

/**
 * 两行是否相等：按「当前主题下序列化后的行文本」比较（序列化文本即最终上屏字节，
 * 内部实现不对外——SPEC.md §14）。caret 变化(纯光标移动)也阻止 delta 合并。
 */
function sameRow(x: FrameRow, y: FrameRow, theme: ColorTheme): boolean {
  if (x.caret !== y.caret) return false;
  return serializeFrameRow(x, theme) === serializeFrameRow(y, theme);
}
