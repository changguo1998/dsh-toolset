// TUI/tests/terminal.test.ts — 终端控制面（renderer/terminal.ts）的缺口锚点
//
// 现有用例只经 `createRenderer` 间接碰到 raw mode（非 TTY 下静默失败）；这里直接对
// `setRawMode` / `createTerminal` 注入假流, 钉住四类判定:
//  - 非 TTY: 不开 raw、不改状态、不调用底层 `setRawMode`;
//  - TTY 成功: 返回值与 `rawEnabled` 跟随底层 `isRaw`;
//  - 底层抛错: `setRawMode` 不冒泡, 回落读 `isRaw`;
//  - 尺寸: TTY 读 `columns/rows`, 非 TTY 或零尺寸回落 80x24（无 TTY 环境的出帧基准）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTerminal,
  setRawMode,
  type TerminalControl,
} from "../src/renderer/terminal.ts";

interface FakeStdin {
  stream: NodeJS.ReadStream;
  calls: boolean[];
}

/** 假 stdin: 只实现 setRawMode 判据用到的 isTTY / isRaw / setRawMode */
function fakeStdin(opts: {
  isTTY: boolean;
  /** 抛错模拟真实终端拒绝切换 */
  throws?: boolean;
}): FakeStdin {
  const calls: boolean[] = [];
  const state = { isRaw: false };
  const stdin = {
    isTTY: opts.isTTY,
    get isRaw(): boolean {
      return state.isRaw;
    },
    setRawMode(on: boolean): void {
      calls.push(on);
      if (opts.throws) throw new Error("setRawMode 失败");
      state.isRaw = on;
    },
  };
  return { stream: stdin as unknown as NodeJS.ReadStream, calls };
}

/** 假 stdout: getSize 只读 isTTY / columns / rows */
function fakeStdout(size: {
  isTTY: boolean;
  columns?: number;
  rows?: number;
}): NodeJS.WriteStream {
  return {
    isTTY: size.isTTY,
    columns: size.columns,
    rows: size.rows,
  } as unknown as NodeJS.WriteStream;
}

test("setRawMode: 非 TTY 静默失败, 不调用底层切换", () => {
  const { stream, calls } = fakeStdin({ isTTY: false });
  assert.equal(setRawMode(stream, true), false);
  assert.deepEqual(calls, [], "非 TTY 不触碰 setRawMode");
});

test("setRawMode: TTY 切换成功, 返回值取底层 isRaw", () => {
  const { stream, calls } = fakeStdin({ isTTY: true });
  assert.equal(setRawMode(stream, true), true);
  assert.deepEqual(calls, [true]);
  assert.equal(setRawMode(stream, false), false);
  assert.deepEqual(calls, [true, false]);
});

test("setRawMode: 底层抛错不冒泡, 回落读 isRaw", () => {
  const { stream } = fakeStdin({ isTTY: true, throws: true });
  assert.equal(setRawMode(stream, true), false, "抛错时按未进入 raw 处理");
});

test("createTerminal: 非 TTY 下 rawMode 不生效, close 幂等恢复", () => {
  const { stream, calls } = fakeStdin({ isTTY: false });
  const terminal: TerminalControl = createTerminal(
    stream,
    fakeStdout({ isTTY: false }),
  );
  assert.equal(terminal.rawMode(true), false);
  assert.equal(terminal.rawEnabled, false);
  terminal.close();
  assert.equal(terminal.rawEnabled, false);
  assert.deepEqual(calls, [], "全程未触碰底层 setRawMode");
});

test("createTerminal: TTY 下 rawMode 生效, close 关闭 raw 并对外反映", () => {
  const { stream, calls } = fakeStdin({ isTTY: true });
  const terminal = createTerminal(stream, fakeStdout({ isTTY: false }));
  assert.equal(terminal.rawMode(true), true);
  assert.equal(terminal.rawEnabled, true);
  terminal.close();
  assert.deepEqual(calls, [true, false], "close 主动关一次 raw");
  assert.equal(terminal.rawEnabled, false);
});

test("createTerminal: 尺寸取 TTY 读数, 非 TTY / 零尺寸回落 80x24", () => {
  const stdin = fakeStdin({ isTTY: false }).stream;
  assert.deepEqual(
    createTerminal(
      stdin,
      fakeStdout({ isTTY: true, columns: 120, rows: 40 }),
    ).getSize(),
    { cols: 120, rows: 40 },
  );
  assert.deepEqual(
    createTerminal(stdin, fakeStdout({ isTTY: false })).getSize(),
    { cols: 80, rows: 24 },
  );
  assert.deepEqual(
    createTerminal(
      stdin,
      fakeStdout({ isTTY: true, columns: 0, rows: 0 }),
    ).getSize(),
    { cols: 80, rows: 24 },
    "报了 TTY 但尺寸为 0 → 同样回落",
  );
});

test("createTerminal: onResize 订阅 process.stdout 的 resize 事件", () => {
  const terminal = createTerminal(fakeStdin({ isTTY: false }).stream);
  let fired = 0;
  const cb = (): void => {
    fired++;
  };
  terminal.onResize(cb);
  process.stdout.emit("resize");
  assert.equal(fired, 1);
  process.stdout.removeListener("resize", cb);
});
