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
