// renderer/index.ts — Renderer 公共 API：terminal + input + screen 的组装
//
// 契约见 DESIGN.md「核心接口契约」。退出生命周期归 renderer：
// close()/SIGINT/SIGTERM/uncaught 一律先恢复终端。

import { Screen, type RenderLine } from "./screen.ts";
import type { Size } from "./screen.ts";
import type { KeyEvent } from "./input.ts";
import { KeyDecoder } from "./input.ts";
import {
  createTerminal,
  installExitHandlers,
  type ExitResult,
} from "./terminal.ts";

export type { RenderLine, KeyEvent };
export type { Size };

export interface Renderer {
  /** 整帧重绘；render 内含末尾追加的 delta 优化 */
  render(lines: RenderLine[]): void;
  /** 强制整帧重绘（绕过 delta 优化，Ctrl+L 用） */
  refresh(lines: RenderLine[]): void;
  onKey(cb: (k: KeyEvent) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  getSize(): Size;
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
  let prevLines: RenderLine[] | null = null;
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
    render(lines: RenderLine[]): void {
      if (closed) return;
      // delta 优化：与上一帧共用前缀，仅末尾变化/追加 → 只写 delta
      if (delta && prevLines) {
        const prefix = commonPrefix(prevLines, lines);
        if (prefix >= prevLines.length) {
          screen.renderDelta(prefix + 1, lines.slice(prefix));
          prevLines = lines;
          return;
        }
      }
      screen.render(lines);
      prevLines = lines;
    },
    refresh(lines: RenderLine[]): void {
      if (closed) return;
      prevLines = null; // 强制走全帧 screen.render(清屏+重绘)
      this.render(lines);
    },
    onKey(cb: (k: KeyEvent) => void): void {
      keyCbs.add(cb);
    },
    onResize(cb: (cols: number, rows: number) => void): void {
      resizeCbs.add(cb);
    },
    getSize(): Size {
      return screen.getSize();
    },
    close(): void {
      if (closed) return;
      closed = true;
      detach(); // 移除退出钩子，防止 close 后再被信号触发
      stdio.removeListener("data", onData);
      process.stdout.removeListener("resize", onResizeEvt);
      process.removeListener("beforeExit", restore);
      terminal.close();
      // DESIGN：close() = 恢复终端 + 退出事件循环
      if (exitOnClose) process.exit(0);
    },
  };
  return renderer;
}

/** 两帧 RenderLine 从头部起相同前缀的行数 */
function commonPrefix(a: RenderLine[], b: RenderLine[]): number {
  let n = 0;
  while (n < a.length && n < b.length && sameLine(a[n]!, b[n]!)) n++;
  return n;
}

function sameLine(x: RenderLine, y: RenderLine): boolean {
  if (x.text !== y.text) return false;
  const sx = x.style !== undefined;
  const sy = y.style !== undefined;
  if (sx !== sy) return false;
  if (!sx) return true;
  const s = x.style! as NonNullable<RenderLine["style"]>;
  const t = y.style! as NonNullable<RenderLine["style"]>;
  return s.fg === t.fg && s.bg === t.bg && s.bold === t.bold;
}
