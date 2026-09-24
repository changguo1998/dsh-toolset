// tests/buffer-trim.test.ts — 缓冲上限裁剪与阅读位置保护
//
// 回归背景：活动区/对话区大量输出会把缓冲顶到上限（MAX_BUFFER_LINES），此前逐行裁掉
// 最旧行——用户上翻阅读时，视口顶行（语义锚点）被一起裁掉，视口只能跟着缓冲头逐帧
// 前移，表现为「活动区输出大量文本时历史区跟着一起上滚」。现在裁剪保留锚点行。

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

test("裁剪保留锚点行：足量新行到达后阅读位置所在行仍在缓冲里（且临时可超上限）", () => {
  let s = appendLines(initialState(), MAX_BUFFER_LINES + 10, "L");
  // 锚点落在缓冲中部（用户上翻阅读的位置）
  const midIdx = Math.floor(s.buffer.length / 2);
  const anchorSeq = s.buffer[midIdx]!.seq!;
  s = { ...s, scrollAnchor: { seq: anchorSeq, row: 0 } };
  // 追加量足以在「无保护」时把锚点行裁掉（= 用户真实遇到的场景）
  s = appendLines(s, midIdx + 100, "M");
  assert.ok(
    s.buffer.some((l) => l.seq === anchorSeq),
    "锚点行必须保留（否则视口会被拽着跟随缓冲头逐帧前移）",
  );
  assert.ok(
    s.buffer.length > MAX_BUFFER_LINES,
    "锚点行退到头行后，为保住阅读位置缓冲会临时超过上限",
  );
  assert.ok(
    s.buffer.length <= MAX_BUFFER_LINES * 2,
    "锚点保护设上限：保留不超过 2× 上限",
  );
});

test("无锚点（跟随底部）仍严格按上限裁剪", () => {
  let s = appendLines(initialState(), MAX_BUFFER_LINES + 500, "L");
  s = { ...s, scrollAnchor: null };
  s = appendLines(s, 10, "M");
  assert.equal(s.buffer.length, MAX_BUFFER_LINES, "跟随底部时缓冲不超上限");
});

test("锚点已不在缓冲（已被裁掉）：按上限裁剪，不做无谓保留", () => {
  let s = appendLines(initialState(), MAX_BUFFER_LINES + 10, "L");
  s = { ...s, scrollAnchor: { seq: 1, row: 0 } }; // 早已被裁掉的旧行号
  s = appendLines(s, 50, "M");
  assert.equal(
    s.buffer.length,
    MAX_BUFFER_LINES,
    "锚点行不在缓冲内 → 退回上限裁剪（由 layout 的 dialogueTopIdx 兜底定位）",
  );
});

test("极端输出超过 2× 上限：放弃锚点保护，按上限裁剪", () => {
  let s = appendLines(initialState(), MAX_BUFFER_LINES, "L");
  const anchorSeq = s.buffer[0]!.seq!; // 锚点贴在缓冲头部
  s = { ...s, scrollAnchor: { seq: anchorSeq, row: 0 } };
  s = appendLines(s, MAX_BUFFER_LINES * 2 + 100, "M");
  assert.ok(
    s.buffer.length <= MAX_BUFFER_LINES * 2,
    "超出 2× 上限 → 安全阀生效（保留量不超过 2× 上限，不再为锚点破例）",
  );
  assert.equal(
    s.buffer.some((l) => l.seq === anchorSeq),
    false,
    "锚点行被放弃（避免缓冲无界增长）",
  );
});
