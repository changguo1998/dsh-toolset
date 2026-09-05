// tests/subagent-compaction.test.ts — P2 阶段 B4+B5：subagent 行 + compaction 摘要 toast
//
// B4：subagent/descriptor → buffer 行 `@ <label> <os|ct>`（append-only 不配对不折叠；
//     one-shot→os / continuable→ct；label 由 adapter 归一化保证非空）。
// B5：compaction-summary → notice toast「压缩完成：<text 首行>」，空摘要给占位；
//     原始载荷保留于 compactionBySession（每会话仅最近一条）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduceState } from "../src/app/state.ts";
import type { StateAction } from "../src/app/state.ts";

const sub = (label: string, mode: "one-shot" | "continuable"): StateAction => ({
  type: "subagent",
  sessionId: "s1",
  label,
  mode,
});

test("B4 subagent 行：`@ <label> <os|ct>` append-only 独立成行", () => {
  let s = initialState();
  s = reduceState(s, sub("reviewer", "one-shot"));
  s = reduceState(s, sub("writer", "continuable"));
  const texts = s.buffer.map((l) => l.text);
  assert.deepEqual(texts, ["@ reviewer os", "@ writer ct"]);
  assert.ok(
    s.buffer.every((l) => l.kind === "tool"),
    "subagent 行复用 tool kind",
  );
});

test("B4 subagent 行：mode 缩略映射 one-shot→os / continuable→ct，label 原样展示", () => {
  const texts = [
    reduceState(initialState(), sub("arch", "one-shot")).buffer.at(-1)!.text,
    reduceState(initialState(), sub("impl", "continuable")).buffer.at(-1)!.text,
  ];
  assert.deepEqual(texts, ["@ arch os", "@ impl ct"]);
});
