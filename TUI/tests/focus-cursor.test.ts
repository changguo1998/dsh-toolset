// tests/focus-cursor.test.ts — 输入焦点与光标收尾（BACKLOG 3.1.3）
//
// 覆盖：
//  1) buildFrame 回填 focus：输入态 inputFocus=true 且 caret 指向输入行；面板态 inputFocus=false
//  2) 真实 renderer 消费 focus：活动区刷新（批次不含输入行）仍把光标定位回输入位置并显示
//  3) 非输入态：不定位、不显示光标（沿用报文开头的隐藏）
//  4) 未传 focus：沿用旧行为（无 caret 批次也保持光标可见）

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderer, type FrameRow } from "../src/renderer/index.ts";
import { buildFrame, type FrameBuildOutput } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";

const SIZE = { rows: 24, cols: 80 };

/** 注入 write 的渲染器：把报文收集到 chunks */
function collector(): {
  chunks: string[];
  renderer: ReturnType<typeof createRenderer>;
} {
  const chunks: string[] = [];
  const renderer = createRenderer({
    write: (s) => chunks.push(s),
    rawMode: false,
    exitOnClose: false,
  });
  return { chunks, renderer };
}

/** 取一帧 + 其回填输出 */
function frameWith(state = initialState()): {
  rows: FrameRow[];
  out: FrameBuildOutput;
} {
  const out: FrameBuildOutput = {};
  const rows = buildFrame(state, SIZE, undefined, out);
  return { rows, out };
}

/** 造一帧：只改第 `idx` 行（0 基）内容，用于触发「批次不含输入行」的增量路径 */
function withChangedRow(
  rows: FrameRow[],
  idx: number,
  text: string,
): FrameRow[] {
  return rows.map((r, i) => (i === idx ? { segments: [{ text }] } : r));
}

test("buildFrame 回填 focus：输入态 inputFocus=true 且 caret 指向输入行", () => {
  const { rows, out } = frameWith();
  const focus = out.focus;
  assert.ok(focus, "应回填 focus");
  assert.equal(focus.inputFocus, true, "输入态应允许输入");
  assert.ok(focus.caret, "输入态应给出输入位置");
  const caretIdx = rows.findIndex((r) => r.caret !== undefined);
  assert.ok(caretIdx >= 0, "输入帧应含 caret 行");
  assert.equal(focus.caret.row, caretIdx + 1, "caret 行号应为帧内 1 基行号");
  assert.equal(
    focus.caret.col,
    rows[caretIdx]!.caret,
    "caret 列应与行上的 caret 一致",
  );
});

test("buildFrame 回填 focus：审批面板态 inputFocus=false 且无输入位置", () => {
  const s = reduceState(initialState(), {
    type: "approval",
    approval: { id: "a1", prompt: "run rm -rf ?" },
  });
  const { rows, out } = frameWith(s);
  assert.equal(out.focus?.inputFocus, false, "面板态不允许输入");
  assert.equal(out.focus?.caret, undefined, "面板帧无输入行");
  assert.equal(
    rows.some((r) => r.caret !== undefined),
    false,
    "面板帧不应出现 caret 行",
  );
});

test("真实 renderer：活动区刷新批次仍定位回输入位置并显示光标", () => {
  const { chunks, renderer } = collector();
  const first = frameWith();
  renderer.render(first.rows, first.out.sections, first.out.focus);
  const mark = chunks.length;

  // 第二帧只有活动区一行变化（模拟流式刷新）：该批 intervals 不含输入行
  renderer.render(
    withChangedRow(first.rows, 3, "streamed"),
    first.out.sections,
    first.out.focus,
  );
  const delta = chunks.slice(mark).join("");
  const caret = first.out.focus!.caret!;
  assert.ok(
    delta.includes(`\x1b[${caret.row};${caret.col + 1}H`),
    "批次结束后应定位回输入位置",
  );
  assert.ok(delta.includes("\x1b[?25h"), "输入态应显示光标");
  assert.ok(!delta.includes("\x1b[2J"), "增量帧不得清屏");
});

test("真实 renderer：非输入态不定位也不显示光标", () => {
  const { chunks, renderer } = collector();
  const first = frameWith();
  renderer.render(first.rows, first.out.sections, first.out.focus);
  const mark = chunks.length;

  renderer.render(withChangedRow(first.rows, 3, "panel"), first.out.sections, {
    inputFocus: false,
  });
  const delta = chunks.slice(mark).join("");
  assert.ok(!delta.includes("\x1b[?25h"), "非输入态不应显示光标");
  assert.ok(delta.includes("\x1b[?25l"), "批次开头仍隐藏光标（重写期不跳动）");
});

test("真实 renderer：未传 focus 沿用旧行为（无 caret 批次也保持光标可见）", () => {
  const { chunks, renderer } = collector();
  const rows: FrameRow[] = [
    { segments: [{ text: "a" }] },
    { segments: [{ text: "b" }] },
  ];
  renderer.render(rows);
  assert.ok(
    chunks.join("").includes("\x1b[?25h"),
    "未传 focus 时应保持光标可见（兼容注入型实现与既有调用）",
  );
});
