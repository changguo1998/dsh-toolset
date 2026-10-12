// renderer/terminal.ts — raw mode、resize 监听、终端恢复（全部退出路径）
//
// 退出生命周期归 renderer 拥有：
//  - close()                          → 显式关闭，恢复终端
//  - SIGINT / SIGTERM                 → 恢复终端后以 130/143 退出
//  - SIGHUP                           → **不退出**：终端挂断（tmux detach / 客户端断开）
//    只作废全帧缓存，会话保活（Node 无处理器时默认直接终止，退出码 129 且不恢复终端）
//  - uncaughtException/unhandledRejection → 恢复终端后写 stderr 并以 1 退出
//    （renderer/index.ts 的处理器口径；错误文本即下沉出口）

export type ExitResult = { exitCode: number } | { injected: unknown };

export interface TerminalControl {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  rawEnabled: boolean;
  rawMode(on: boolean): boolean; // 返回值：是否成功切换
  onResize(cb: () => void): void;
  getSize(): { cols: number; rows: number };
  close(): void;
}

/** 打开/关闭 raw mode（非 TTY 时静默失败，返回当前状态） */
export function setRawMode(stream: NodeJS.ReadStream, on: boolean): boolean {
  if (!stream.isTTY) return false;
  try {
    stream.setRawMode(on);
  } catch {
    return stream.isRaw;
  }
  return stream.isRaw;
}

/** 常用退出码 */
export const EXIT_INTERRUPT = 130;
export const EXIT_TERM = 143;

/**
 * 挂载退出处理器到所有退出路径，返回解绑函数。
 * handler 收到 { exitCode }（信号/正常调用）或 { injected }（未捕获异常）。
 * onHangup（可选）：收到 SIGHUP 时调用。**SIGHUP 不结束会话**——tmux detach / 客户端
 * 断开 / 父终端收起都会让内核发 SIGHUP，而 Node 对无处理器的 SIGHUP 默认动作是直接终止
 * （实测退出码 129，且不走终端恢复，画面可能残留在 raw/alt 状态）。终端真没了时 stdout
 * 写入会失败并落到 uncaughtException 出口，进程照样会退出，故此处不退出不会留下孤儿。
 */
export function installExitHandlers(
  handler: (r: ExitResult) => void,
  onHangup?: () => void,
): () => void {
  const onSignal = (code: number) => (): void => {
    handler({ exitCode: code });
  };
  const sigint = onSignal(EXIT_INTERRUPT);
  const sigterm = onSignal(EXIT_TERM);
  const sighup = (): void => {
    onHangup?.();
  };
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  process.on("SIGHUP", sighup);

  const onError = (err: unknown): void => {
    handler({ injected: err });
  };
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);

  return () => {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
    process.removeListener("SIGHUP", sighup);
    process.removeListener("uncaughtException", onError);
    process.removeListener("unhandledRejection", onError);
  };
}

/** 实现一个 TerminalControl，默认绑 process.stdin/stdout */
export function createTerminal(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout = process.stdout as NodeJS.WriteStream,
): TerminalControl {
  let rawEnabled = false;

  const terminal: TerminalControl = {
    stdin,
    stdout,
    get rawEnabled() {
      return rawEnabled;
    },
    rawMode(on: boolean): boolean {
      if (setRawMode(stdin, on)) rawEnabled = on;
      return rawEnabled;
    },
    onResize(cb: () => void): void {
      process.stdout.on("resize", cb);
    },
    getSize(): { cols: number; rows: number } {
      const size =
        stdout.isTTY && stdout.columns && stdout.rows
          ? { cols: stdout.columns, rows: stdout.rows }
          : { cols: 0, rows: 0 };
      return size.cols > 0 ? size : { cols: 80, rows: 24 }; // 默认尺寸便于无 TTY 环境
    },
    close(): void {
      setRawMode(stdin, false);
      rawEnabled = false;
    },
  };
  return terminal;
}
