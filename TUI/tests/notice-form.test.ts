// tests/notice-form.test.ts — TUI#17：`source.form:'notice'` 注入消息的归一与渲染
//
// 覆盖：noticeSummaryOf 判定（summary 优先 / 缺省取正文首行 / 截断 ≤120 / 非 notice
// → undefined）；surfaceToBuffer 的 notice 行（log 灰、单行、空白不产出）；恢复后渲染
// （活动区单行提示行，不产生用户块）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame } from "../src/app/layout.ts";
import { surfaceToBuffer } from "../src/app/commands.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { noticeSummaryOf } from "../src/app/adapter/normalize.ts";
import { rowText } from "./helpers/rowText.ts";

test("TUI#17 noticeSummaryOf：notice 取 summary；缺省取正文首行；非 notice → undefined", () => {
  assert.equal(
    noticeSummaryOf({
      content: [{ type: "text", text: "正文" }],
      source: { kind: "rule-engine", form: "notice", summary: "一行摘要" },
    }),
    "一行摘要",
    "summary 优先",
  );
  assert.equal(
    noticeSummaryOf({
      content: [{ type: "text", text: "  首行摘要  \n第二行" }],
      source: { kind: "rule-engine", form: "notice", summary: "   " },
    }),
    "首行摘要",
    "summary 空白 → 取正文首个非空行",
  );
  assert.equal(
    noticeSummaryOf({
      content: [{ type: "text", text: "字".repeat(200) }],
      source: { form: "notice" },
    })?.length,
    120,
    "无 summary 的首行摘要截断 ≤120",
  );
  assert.equal(
    noticeSummaryOf({
      content: [{ type: "text", text: "x" }],
      source: { kind: "user" },
    }),
    undefined,
    "非 notice 形态不判定",
  );
  assert.equal(noticeSummaryOf(null), undefined, "非对象 → undefined");
  assert.equal(
    noticeSummaryOf({ source: { form: "notice" } }),
    undefined,
    "无 summary 且无正文 → undefined（调用方按普通消息处理）",
  );
});

test("TUI#17 surfaceToBuffer：notice 行 → kind notice + log 灰；空白行不产出", () => {
  const rows = surfaceToBuffer([
    { role: "notice", text: "已提醒模型统一符号" },
    { role: "notice", text: "   " },
    { role: "user", text: "问题" },
  ]);
  assert.deepEqual(rows, [
    { text: "已提醒模型统一符号", kind: "notice", tone: "log" },
    { text: "问题", kind: "user", final: undefined },
  ]);
});

test("TUI#17 渲染：恢复后 notice 摘要行单行显示、buffer 中不占用户块", () => {
  let s = initialState();
  s.activeSessionId = "s1";
  s = reduceState(s, { type: "history-open" });
  s = reduceState(s, { type: "history-resume", id: "old-1" });
  s = reduceState(s, {
    type: "history-resume-ok",
    id: "old-1",
    title: "旧会话",
    rows: surfaceToBuffer([
      { role: "notice", text: "已提醒模型统一符号" },
      { role: "user", text: "问题" },
      { role: "assistant", text: "回复" },
    ]),
  });
  const lines = buildFrame(s, { rows: 24, cols: 100 }).map((r) => rowText(r));
  assert.ok(
    lines.some((t) => t.includes("已提醒模型统一符号")),
    `notice 摘要行应可见: ${lines.join("|")}`,
  );
  const line = s.buffer.find((l) => l.text.includes("已提醒模型统一符号"));
  assert.equal(line?.kind, "notice", "该行 kind=notice（非 user 块）");
  assert.equal(line?.tone, "log", "log 灰（一行提示口径）");
});
