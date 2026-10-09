// tests/buffer-trim.test.ts — 缓冲头部裁剪的现行契约
//
// 会话内容真源已迁到节缓存（`state.pipeline`），缓冲不再参与构帧（视口顶按「段键 + 段内行」
// 定位，见 `layout/pipeline/rows.ts`），故裁剪**不再为阅读位置让路**：一律按上限裁。
// 旧契约「保留语义锚点所在行、缓冲可临时到 2× 上限」随锚点模型一并退场（2026-10-09）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BUFFER_LINES,
  initialState,
  reduceState,
  type AppState,
} from "../src/app/state.ts";

/** 逐行追加（notice 行不并入上一行，行数可控：n 行 = n 个 buffer 行） */
function appendLines(state: AppState, n: number, tag: string): AppState {
  let s = state;
  for (let i = 0; i < n; i++)
    s = reduceState(s, { type: "notice", text: `${tag}-${i}` });
  return s;
}

test("超过上限即按上限裁剪（不因滚动位置保留更多）", () => {
  const s = appendLines(initialState(), MAX_BUFFER_LINES + 500, "L");
  assert.equal(s.buffer.length, MAX_BUFFER_LINES, "缓冲不超上限");
});

test("用户停在历史里（dialogueTop 非 null）同样按上限裁剪", () => {
  let s = appendLines(initialState(), MAX_BUFFER_LINES + 10, "L");
  s = { ...s, dialogueTop: { key: "1:0", row: 0 } };
  s = appendLines(s, 100, "M");
  assert.equal(
    s.buffer.length,
    MAX_BUFFER_LINES,
    "不再为锚点破例（视口位置按段键定位，与缓冲无关）",
  );
});

test("连续追加始终不越界（裁剪是持续的，不是一次性的）", () => {
  let s = appendLines(initialState(), MAX_BUFFER_LINES, "L");
  s = appendLines(s, MAX_BUFFER_LINES * 2, "M");
  assert.equal(s.buffer.length, MAX_BUFFER_LINES, "多轮追加后仍不超上限");
});
