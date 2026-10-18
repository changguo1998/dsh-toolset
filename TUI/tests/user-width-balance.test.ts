// tests/user-width-balance.test.ts —— 会话区用户块平衡折行（行数不变、按 C = ceil(L/R) 收窄）
//
// 算法：总显示宽 L、最大列宽 Cmax → R = ceil(L / Cmax)，C = ceil(L / R)；
// 宽字符取整可能多折一行时右移列宽直到行数回到 R。只作用于用户块。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFrame, displayWidth, rowText } from "../src/app/layout.ts";
import { balancedWidth } from "../src/app/layout/fill.ts";
import { wrapFrameSegments } from "../src/app/layout/markdown.ts";
import { sectionsFromBuffer } from "../src/app/layout/pipeline/replay.ts";
import { initialState } from "../src/app/state.ts";

const segs = (text: string) => [{ text }];

test("balancedWidth：60 列文本在 34 列宽下取 30 列（两行各 30）", () => {
  const text = "甲".repeat(30); // L = 60
  const width = balancedWidth(segs(text), 34, 0);
  assert.equal(width, 30);
  assert.equal(wrapFrameSegments(segs(text), width, 0).length, 2);
});

test("balancedWidth：单行 / 更窄时原样返回", () => {
  assert.equal(balancedWidth(segs("短文本"), 40, 0), 40);
});

test("balancedWidth：宽字符取整多出一行时右移列宽", () => {
  // L=62、Cmax=60 → R=2，ceil(62/2)=31 按宽字符会折成 3 行 → 修正到 32
  const text = "甲".repeat(31);
  const width = balancedWidth(segs(text), 60, 0);
  assert.equal(width, 32);
  assert.equal(wrapFrameSegments(segs(text), width, 0).length, 2, "保持 2 行");
});

test("端到端：用户块两行等宽，行数不变", () => {
  const text = "甲".repeat(30);
  const rows = [{ text, kind: "user", turn: 1 }] as never;
  const state = {
    ...initialState(),
    pipeline: sectionsFromBuffer(rows, { history: true }),
  };
  const lines = buildFrame(state, { cols: 60, rows: 20 })
    .map((row) => rowText(row))
    .filter((line) => line.includes("甲"));
  assert.equal(lines.length, 2, `两行（实际 ${lines.length}）`);
  const widths = lines.map((line) => {
    const chars = Array.from(line).filter((ch) => ch === "甲");
    return chars.length * 2;
  });
  assert.deepEqual(widths, [30, 30], "两行各 15 个宽字符");
});

test("端到端：含显式换行不启用平衡（行内容原样）", () => {
  const text = "第一段比较长的内容".repeat(2) + "\n" + "第二段";
  const rows = [{ text, kind: "user", turn: 1 }] as never;
  const state = {
    ...initialState(),
    pipeline: sectionsFromBuffer(rows, { history: true }),
  };
  const frame = buildFrame(state, { cols: 60, rows: 20 })
    .map((row) => rowText(row))
    .join("\n");
  assert.ok(frame.includes("第二段"), "第二段保留");
  assert.ok(frame.includes("第一段"), "第一段保留");
});

test("balancedWidth：窄窗不越界（结果 ≤ Cmax）", () => {
  const text = "甲".repeat(20);
  for (const max of [5, 9, 13]) {
    const width = balancedWidth(segs(text), max, 0);
    assert.ok(width <= max, `C=${width} ≤ Cmax=${max}`);
    assert.ok(width >= 1);
  }
});

test("balancedWidth：显示宽与字符数无关的混排", () => {
  const text = "甲乙丙abc丁戊己";
  const width = balancedWidth(segs(text), 20, 0);
  assert.ok(width <= 20 && width >= 1);
  assert.ok(displayWidth(text) > 0);
});
