// tests/width-probe.test.ts — 终端宽度探测（方案 ② 的探测侧）
//
// 覆盖：KeyDecoder 识别 CPR 响应（不产生按键）、probeSymbolWidths 批量列差解析、
// 终端无响应时的超时回退、setWidthOverrides 实测值优先于静态表并使缓存失效。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderer } from "../src/renderer/index.ts";
import { KeyDecoder } from "../src/renderer/input.ts";
import {
  charWidth,
  clearWidthOverrides,
  setWidthOverrides,
} from "../src/app/layout/markdown.ts";

test("KeyDecoder：CPR 响应走 onCpr 回调，不产生按键事件", () => {
  const d = new KeyDecoder();
  const got: Array<[number, number]> = [];
  d.onCpr = (row, col) => got.push([row, col]);
  assert.deepEqual(d.feed(Buffer.from("\x1b[3;7R")), [], "CPR 不应产出按键");
  assert.deepEqual(got, [[3, 7]], "应上报解析出的行列");
  // 后续输入不受影响（CPR 已完整消费）
  const keys = d.feed(Buffer.from("a\x1b[1;5R"));
  assert.deepEqual(
    keys.map((k) => k.name),
    ["a"],
    "CPR 之后仍能正常解码按键",
  );
  assert.deepEqual(got, [
    [3, 7],
    [1, 5],
  ]);
});

test("probeSymbolWidths：批量写「字符 + CSI 6n」，按列差解析宽度", async () => {
  let out = "";
  const renderer = createRenderer({
    write: (s) => (out += s),
    rawMode: false,
    exitOnClose: false,
  });
  const pending = renderer.probeSymbolWidths!(["a", "\u4E2D", "b"]);
  // 探测报文应包含定位与逐字符的 CSI 6n 查询
  assert.ok(out.startsWith("\x1b[1;1H"), "先定位原点");
  assert.equal(
    out.split("\x1b[6n").length - 1,
    3,
    "每个字符后各发一次 CPR 查询",
  );
  // 模拟终端应答：a(1 列) → 列 2；中(2 列) → 列 4；b(1 列) → 列 5
  renderer.emitCpr!(1, 2);
  renderer.emitCpr!(1, 4);
  renderer.emitCpr!(1, 5);
  const widths = await pending;
  assert.equal(widths.get("a"), 1);
  assert.equal(widths.get("\u4E2D"), 2);
  assert.equal(widths.get("b"), 1);
  renderer.close();
});

test("probeSymbolWidths：终端不响应时超时返回已收集结果", async () => {
  const renderer = createRenderer({
    write: () => {},
    rawMode: false,
    exitOnClose: false,
  });
  const pending = renderer.probeSymbolWidths!(["a", "b"], 30);
  renderer.emitCpr!(1, 2); // 只应答第一个
  const widths = await pending; // 超时后返回
  assert.equal(widths.get("a"), 1, "已收集的部分保留");
  assert.equal(widths.has("b"), false, "未应答的字符不记录");
  renderer.close();
});

test("probeSymbolWidths：跨行（自动换行）的字符跳过，同线内仍解析", async () => {
  const renderer = createRenderer({
    write: () => {},
    rawMode: false,
    exitOnClose: false,
  });
  const pending = renderer.probeSymbolWidths!(["a", "b"]);
  renderer.emitCpr!(1, 2); // a → 1 列
  renderer.emitCpr!(2, 3); // 换行后的 b → 列差不可用，跳过
  const widths = await pending;
  assert.equal(widths.get("a"), 1);
  assert.equal(widths.has("b"), false);
  renderer.close();
});

test("setWidthOverrides：实测值优先于静态表，并使排版缓存失效", () => {
  clearWidthOverrides();
  try {
    // 静态判定：U+25CB 属 A 类且不在保守区间 → 1 列
    assert.equal(charWidth("\u25CB"), 1, "静态表判定 1 列");
    assert.equal(setWidthOverrides([["\u25CB", 2]]), true, "首次设置应有变化");
    assert.equal(charWidth("\u25CB"), 2, "实测值覆盖静态判定");
    assert.equal(
      setWidthOverrides([["\u25CB", 2]]),
      false,
      "同值重复设置不再失效缓存",
    );
  } finally {
    clearWidthOverrides();
  }
  assert.equal(charWidth("\u25CB"), 1, "清除覆盖后回到静态判定");
});
