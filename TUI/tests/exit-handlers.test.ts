// tests/exit-handlers.test.ts — 退出路径的信号口径（renderer/terminal.ts）
//
// 覆盖：SIGINT/SIGTERM 照旧走退出处理器（130/143）；**SIGHUP 不退出**——只通知 onHangup，
// 因为 tmux detach / 客户端断开都会发 SIGHUP，而把「终端挂断」当退出会直接丢会话
// （BACKLOG〈tmux 在 dsh 所在 window 内 detach 会让程序退出〉）。
// 用 process.emit() 触发监听器而不是真发信号：测试进程内无副作用，且能断言调用次数。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_INTERRUPT,
  EXIT_TERM,
  installExitHandlers,
  type ExitResult,
} from "../src/renderer/terminal.ts";

test("SIGHUP 不退出：只触发 onHangup，不进退出处理器", () => {
  const results: ExitResult[] = [];
  let hangups = 0;
  const off = installExitHandlers(
    (r) => results.push(r),
    () => {
      hangups++;
    },
  );
  try {
    process.emit("SIGHUP");
    assert.equal(hangups, 1, "onHangup 被调用一次");
    assert.equal(results.length, 0, "SIGHUP 不产生退出结果");
  } finally {
    off();
  }
});

test("SIGINT / SIGTERM 口径不变（130 / 143）", () => {
  const results: ExitResult[] = [];
  const off = installExitHandlers(
    (r) => results.push(r),
    () => {},
  );
  try {
    process.emit("SIGINT");
    process.emit("SIGTERM");
    assert.deepEqual(results, [
      { exitCode: EXIT_INTERRUPT },
      { exitCode: EXIT_TERM },
    ]);
  } finally {
    off();
  }
});

test("不传 onHangup：SIGHUP 被吞掉且不抛（不退出、不产生退出结果）", () => {
  const results: ExitResult[] = [];
  const off = installExitHandlers((r) => results.push(r));
  try {
    process.emit("SIGHUP");
    assert.equal(results.length, 0);
  } finally {
    off();
  }
});

test("解绑后信号不再触达（SIGHUP 与 SIGINT 均如此）", () => {
  const results: ExitResult[] = [];
  let hangups = 0;
  const off = installExitHandlers(
    (r) => results.push(r),
    () => {
      hangups++;
    },
  );
  off();
  process.emit("SIGHUP");
  process.emit("SIGINT");
  assert.equal(hangups, 0);
  assert.equal(results.length, 0);
});
