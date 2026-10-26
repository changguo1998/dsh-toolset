// tests/fullscreen-alt-screen.test.ts — 全屏（备用屏）进出
//
// 2026-10-27 用户裁定：启动即切到备用屏（ESC[?1049h），退出还原原屏幕（ESC[?1049l）；
// **不把当前帧内容写回普通屏幕**——终端回滚缓冲因此不参与翻页，PgUp/PgDn 只归应用。

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRenderer } from "../src/renderer/index.ts";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

test("全屏：启动写 1049h、close 写 1049l，且退出不写回帧内容", () => {
  const writes: string[] = [];
  const original = process.exit;
  process.exit = ((code?: number) => {
    void code;
    return undefined as never;
  }) as typeof process.exit;
  try {
    const renderer = createRenderer({
      write: (s) => writes.push(s),
      rawMode: true,
    });
    const start = writes.join("");
    assert.ok(start.includes(ALT_ON), "启动进入备用屏");
    assert.equal(
      start.split(ALT_ON).length - 1,
      1,
      "进入备用屏只写一次（幂等）",
    );
    assert.ok(
      start.indexOf(ALT_ON) < start.indexOf("\x1b[?2004h"),
      "先切备用屏再开 bracketed paste",
    );

    renderer.render([{ segments: [{ text: "帧内容" }] } as never]);
    const before = writes.length;
    renderer.close({ exit: false });
    const tail = writes.slice(before).join("");
    assert.ok(tail.includes(ALT_OFF), "close 退出备用屏（还原原屏幕）");
    assert.ok(!tail.includes("帧内容"), "退出不把当前帧内容写回普通屏幕");
    assert.equal(writes.join("").split(ALT_OFF).length - 1, 1, "只退一次");
  } finally {
    process.exit = original;
  }
});
