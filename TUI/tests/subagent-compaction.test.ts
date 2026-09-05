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

const raw = { compactionId: "c1", model: "deepseek-v4" };

test("B5 compaction 摘要 toast：非空 text 取首行 `压缩完成：<text 首行>`", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "compaction-summary",
    sessionId: "s1",
    text: "第一行总结\n第二行",
    raw,
  });
  const texts = s.buffer.map((l) => l.text);
  assert.deepEqual(texts, ["压缩完成：第一行总结"]);
});

test("B5 compaction 摘要空文本：toast 给「压缩完成（无摘要）」", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "compaction-summary",
    sessionId: "s1",
    text: "",
    raw: { compactionId: "c2" },
  });
  assert.deepEqual(s.buffer.map((l) => l.text), ["压缩完成（无摘要）"]);
});

test("B5 compaction 摘要：原始载荷保留于 state，每会话仅最近一条", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "compaction-summary",
    sessionId: "s1",
    text: "旧",
    raw: { compactionId: "c-old" },
  });
  s = reduceState(s, {
    type: "compaction-summary",
    sessionId: "s1",
    text: "新",
    raw: { compactionId: "c-new" },
  });
  s = reduceState(s, {
    type: "compaction-summary",
    sessionId: "s2",
    text: "另一会话",
    raw: { compactionId: "c-s2" },
  });
  assert.deepEqual(s.compactionBySession["s1"], {
    text: "新",
    raw: { compactionId: "c-new" },
  });
  assert.equal(s.compactionBySession["s2"]!.text, "另一会话");
  // toast 行按事件累计（每个摘要一条 notice）
  assert.deepEqual(
    s.buffer.map((l) => l.text),
    ["压缩完成：旧", "压缩完成：新", "压缩完成：另一会话"],
  );
});
