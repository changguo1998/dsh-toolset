// tests/renderer.test.ts — Renderer 合成按键注入（emitKey）与 close 生命周期

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderer, type KeyEvent } from "../src/renderer/index.ts";

test("emitKey 不经 stdin 即可向 onKey 回调注入按键", () => {
  const out: string[] = [];
  const renderer = createRenderer({
    write: (s) => out.push(s),
    rawMode: false,
    exitOnClose: false,
  });
  const got: KeyEvent[] = [];
  renderer.onKey((k) => got.push(k));

  renderer.emitKey({ name: "m", ctrl: false, meta: false, shift: false });
  renderer.emitKey({ name: "enter", ctrl: false, meta: false, shift: false });
  renderer.close();

  assert.deepEqual(
    got.map((k) => k.name),
    ["m", "enter"],
  );
});

test("bracketed paste：启动写启用序列、关闭写还原序列（条目 11）", () => {
  const out: string[] = [];
  const renderer = createRenderer({
    write: (s) => out.push(s),
    // rawMode 缺省 true（真终端口径）；非 TTY 下 setRawMode 静默失败，无副作用
    exitOnClose: false,
  });
  assert.ok(
    out.join("").includes("\x1b[?2004h"),
    "启动启用 bracketed paste: " + JSON.stringify(out.join("")),
  );
  renderer.close();
  const all = out.join("");
  assert.ok(all.includes("\x1b[?2004l"), "关闭还原终端粘贴行为");
  assert.equal(all.split("\x1b[?2004l").length - 1, 1, "还原序列只写一次");
});

test("rawMode: false（测试 / 无 TTY）不写粘贴模式序列", () => {
  const out: string[] = [];
  const renderer = createRenderer({
    write: (s) => out.push(s),
    rawMode: false,
    exitOnClose: false,
  });
  renderer.close();
  assert.ok(!out.join("").includes("2004"), "不写模式序列");
});
