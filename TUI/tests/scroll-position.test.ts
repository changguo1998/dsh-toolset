// tests/scroll-position.test.ts — 滚动位置模型（段键 + 段内行）的契约
//
// 取代旧的 `scroll-anchor.test.ts`（语义锚点模型 2026-10-09 退场）。口径见
// `TUI/docs/implementation/2026-10-09-layout-segment-cache.md`「滚动位置模型」：
//   - 位置 = **段键 + 段内行**（段 = 占位行 + 会话区各 pane 项），不是绝对行号；
//   - 上方插入段（扩窗纳入更早回合）→ 段键不变 ⇒ 同一内容留在原处（画面不动）；
//   - 宽度变化 → 段内行数变，按段键重定位到同一段，行号超界夹到该段末行；
//   - 段整个消失（该节被裁掉）→ 回落「距底偏移」。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLineTable,
  indexOfTop,
  positionAt,
  segmentAt,
  totalLines,
  TOP_OLDEST_KEY,
} from "../src/app/layout/pipeline/rows.ts";
import { turnGroupStarts } from "../src/app/layout.ts";
import type { Buffer } from "../src/app/state.ts";

const BIG = 10_000;

test("段表：行数与前缀和（总行数 = 各段之和）", () => {
  const t = createLineTable([3, 0, 4]);
  assert.equal(totalLines(t), 7);
  assert.deepEqual([...t.counts], [3, 0, 4]);
  assert.equal(segmentAt(t, 0), 0);
  assert.equal(segmentAt(t, 2), 0);
  assert.equal(segmentAt(t, 3), 2, "空段被跳过（前缀和相同 → 二分取后一段）");
  assert.equal(segmentAt(t, 6), 2);
});

test("位置往返：行号 ↔ (段键, 段内行) 一致；越界收敛", () => {
  const t = createLineTable([3, 4, 5]);
  const keys = ["a", "b", "c"];
  for (const idx of [0, 2, 3, 6, 7, 11]) {
    const top = positionAt(t, keys, idx);
    assert.equal(indexOfTop(t, keys, top, 0, BIG), idx, `行号 ${idx}`);
  }
  assert.deepEqual(positionAt(t, keys, -5), { key: "a", row: 0 });
  assert.deepEqual(positionAt(t, keys, 999), { key: "c", row: 4 });
  assert.deepEqual(positionAt(createLineTable([]), [], 0), { key: "", row: 0 });
});

test("上方插入段（扩窗）不动画面：绝对行号后移，段键与段内行不变", () => {
  const before = createLineTable([3, 4, 5]);
  const keysBefore = ["a", "b", "c"];
  const top = positionAt(before, keysBefore, 5); // 段 b、段内 2
  assert.deepEqual(top, { key: "b", row: 2 });
  const idxBefore = indexOfTop(before, keysBefore, top, 0, BIG);

  // 扩窗：更早回合（10 行）插到最前
  const after = createLineTable([10, 3, 4, 5]);
  const keysAfter = ["x", "a", "b", "c"];
  const idxAfter = indexOfTop(after, keysAfter, top, 0, BIG);
  assert.equal(idxAfter, idxBefore + 10, "同一内容在新表里后移 10 行");
  assert.deepEqual(
    positionAt(after, keysAfter, idxAfter),
    top,
    "段键 + 段内行不变 ⇒ 视口内容不动（撞窗口顶不再多滚十几行）",
  );
});

test("宽度变化（段内行数变）：按段键重定位，行号超界夹到该段末行", () => {
  const wide = createLineTable([3, 6]);
  const keys = ["a", "b"];
  const top = positionAt(wide, keys, 8); // 段 b、段内 5
  assert.deepEqual(top, { key: "b", row: 5 });
  const narrow = createLineTable([3, 2]); // b 重排后只剩 2 行
  assert.equal(
    indexOfTop(narrow, keys, top, 0, BIG),
    3 + 1,
    "夹到该段末行（3 + 2 − 1）",
  );
});

test("段消失 → 回落距底偏移；哨兵「最旧」→ 第 0 行；null → 贴底", () => {
  const t = createLineTable([5, 5]);
  assert.equal(
    indexOfTop(t, ["x", "y"], { key: "gone", row: 3 }, 4, 10),
    6,
    "maxTop − 距底偏移",
  );
  assert.equal(
    indexOfTop(t, ["x", "y"], { key: TOP_OLDEST_KEY, row: 0 }, 0, 10),
    0,
  );
  assert.equal(indexOfTop(t, ["x", "y"], null, 7, 10), 10, "贴底 = maxTop");
});

test("turnGroupStarts：user 行与无 user 前缀的回复起头都算组起点", () => {
  const b: Buffer = [
    { text: "a0", kind: "assistant", final: true },
    { text: "u1", kind: "user" },
    { text: "a1", kind: "assistant", final: true },
    { text: "a1b", kind: "assistant" },
    { text: "u2", kind: "user" },
    { text: "a2", kind: "assistant", final: true },
  ];
  assert.deepEqual(turnGroupStarts(b), [0, 1, 4]);
  // 无 user 行的恢复会话：按回复起头切分（否则永不折叠）
  const restored: Buffer = [
    { text: "a1", kind: "assistant", final: true },
    { text: "sep", kind: "separator" },
    { text: "a2", kind: "assistant", final: true },
  ];
  assert.deepEqual(turnGroupStarts(restored), [0, 2]);
});

test("turnGroupStarts：非 final 中间输出不算组起点——单回合多 step 不被截断", () => {
  // 回归：非 final 的 assistant（思考/工具之间的中间输出）若也算回复组起点，单回合
  // 会被切碎成多组 → 渐进窗口尾部 N 组会截掉本回合早期活动内容（活动区大片空白）。
  const b: Buffer = [
    { text: "u", kind: "user" },
    { text: "sep", kind: "separator" },
    { text: "思考", kind: "thinking" },
    { text: "分析甲", kind: "assistant" },
    { text: "t1", kind: "tool" },
    { text: "分析乙", kind: "assistant" },
    { text: "t2", kind: "tool" },
    { text: "回复", kind: "assistant", final: true },
  ];
  assert.deepEqual(turnGroupStarts(b), [0, 7], "仅 user 与 final 回复算组起点");
});
