// tests/resume-summary.test.ts — P9：恢复会话的 step 概要行（映射 + 渲染）
//
// 口径（docs/PENDING-FIXES.md P9）：恢复行形态与实时 step 头同族——
//   `╌╌ 22:31:05 #3 ╌╌ read ×2, bash ✗1 ╌╌╌…`；
// 空文本不产行（宿主每步补发的纯换行文本块不再变成空行）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame } from "../src/app/layout.ts";
import { surfaceToBuffer } from "../src/app/commands.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { rowText } from "./helpers/rowText.ts";

test("P9 surfaceToBuffer：step 行原样成行；整条空文本不产行", () => {
  const rows = surfaceToBuffer([
    { role: "user", text: "问题" },
    { role: "step", text: "22:31:05 #3 ╌╌ read ×2, bash ✗1" },
    { role: "assistant", text: "\n\n" },
    { role: "assistant", text: "回复正文" },
  ]);
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.text}`),
    ["user:问题", "step:22:31:05 #3 ╌╌ read ×2, bash ✗1", "assistant:回复正文"],
  );
});

test("P9 渲染：step 行 = `╌╌ <文本> ` + 尾部 ╌ 铺满，且位于历史区", () => {
  let s = initialState();
  s.activeSessionId = "s1";
  s = reduceState(s, { type: "history-open" });
  s = reduceState(s, { type: "history-resume", id: "old-1" });
  s = reduceState(s, {
    type: "history-resume-ok",
    id: "old-1",
    title: "旧会话",
    rows: surfaceToBuffer([
      { role: "user", text: "问题" },
      { role: "step", text: "22:31:05 #3 ╌╌ read ×2" },
      { role: "assistant", text: "回复正文" },
    ]),
  });
  const lines = buildFrame(s, { rows: 24, cols: 100 }).map((r) => rowText(r));
  const step = lines.find((t) => t.includes("read ×2"));
  assert.ok(step, `step 概要行应可见: ${lines.join("|")}`);
  assert.ok(
    step.includes("╌╌ 22:31:05 #3 ╌╌ read ×2 "),
    `` + `前缀与内部分隔: ${step}`,
  );
  assert.ok(/read ×2 ╌+/.test(step), `尾部用 ╌ 铺满: ${step}`);
  // 无空行：恢复后的 buffer 里不能出现纯空行
  assert.ok(
    !s.buffer.some((l) => l.text.trim() === ""),
    `恢复行不含空行: ${JSON.stringify(s.buffer.map((l) => l.text))}`,
  );
});
