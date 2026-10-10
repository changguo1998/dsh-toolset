// tests/resume-summary.test.ts — P9：恢复会话的 step 概要行（映射 + 渲染）
//
// 口径（docs/PENDING-FIXES.md P9）：恢复行形态与实时 step 头同族——
//   `╌╌ 22:31:05 #3 ╌╌ read ×2, bash ✗1 ╌╌╌…`；
// 空文本不产行（宿主每步补发的纯换行文本块不再变成空行）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame } from "../src/app/layout.ts";
import { surfaceToBuffer } from "../src/app/commands.ts";
import { normalizeHistoryMessages } from "../src/app/adapter/dsh.ts";
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

test("恢复：用户块终态按 turn/end 的 reason 读回（completed → ✓ / error → ✗ / 其余不落）", () => {
  const msgs = normalizeHistoryMessages([
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 2,
      data: { turn: 1, content: [{ type: "text", text: "问题一" }] },
    },
    {
      type: "turn/end",
      seq: 3,
      data: { turn: 1, reason: { kind: "completed" } },
    },
    { type: "turn/start", seq: 4, data: { turn: 2 } },
    {
      type: "user/message",
      seq: 5,
      data: { turn: 2, content: [{ type: "text", text: "问题二" }] },
    },
    { type: "turn/end", seq: 6, data: { turn: 2, reason: { kind: "error" } } },
    { type: "turn/start", seq: 7, data: { turn: 3 } },
    {
      type: "user/message",
      seq: 8,
      data: { turn: 3, content: [{ type: "text", text: "问题三" }] },
    },
    {
      type: "turn/end",
      seq: 9,
      data: { turn: 3, reason: { kind: "max-tokens" } },
    },
  ]);
  assert.deepEqual(
    msgs.filter((m) => m.role === "user").map((m) => [m.text, m.status ?? "-"]),
    [
      ["问题一", "success"],
      ["问题二", "failure"],
      ["问题三", "-"],
    ],
    "completed → success、error → failure、max-tokens 不落终态",
  );
  // 终态随用户行透传（重放器据此还原符号，不再一律 `?`）
  const rows = surfaceToBuffer(msgs);
  assert.deepEqual(
    rows.filter((r) => r.kind === "user").map((r) => r.status ?? "-"),
    ["success", "failure", "-"],
  );
});

test("恢复：帧里两个用户块分别显示 ✓ 与 ✗（不再一律 `?`）", () => {
  const msgs = normalizeHistoryMessages([
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 2,
      data: { turn: 1, content: [{ type: "text", text: "问题一" }] },
    },
    {
      type: "assistant/message",
      seq: 3,
      data: {
        turn: 1,
        message: { content: [{ type: "text", text: "答复一" }] },
      },
    },
    {
      type: "turn/end",
      seq: 4,
      data: { turn: 1, reason: { kind: "completed" } },
    },
    { type: "turn/start", seq: 5, data: { turn: 2 } },
    {
      type: "user/message",
      seq: 6,
      data: { turn: 2, content: [{ type: "text", text: "问题二" }] },
    },
    { type: "turn/end", seq: 7, data: { turn: 2, reason: { kind: "error" } } },
  ]);
  let s = initialState();
  s = reduceState(s, {
    type: "history-restore",
    id: "s1",
    title: "恢复会话",
    rows: surfaceToBuffer(msgs),
  });
  const lines = buildFrame(s, { cols: 80, rows: 24 }).map(rowText);
  const first = lines.find((l) => l.includes("问题一"));
  const second = lines.find((l) => l.includes("问题二"));
  assert.ok(
    first?.includes("✓ 问题一"),
    `第一块应为 ✓：${JSON.stringify(first)}`,
  );
  assert.ok(
    second?.includes("✗ 问题二"),
    `第二块应为 ✗：${JSON.stringify(second)}`,
  );
});

test("恢复：帧里出现工具批行（工具名 + 结果符号），不再只剩空行", () => {
  const msgs = normalizeHistoryMessages([
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 2,
      data: { turn: 1, content: [{ type: "text", text: "跑一下" }] },
    },
    { type: "step/start", seq: 3, time: 1, data: { turn: 1, step: 1 } },
    {
      type: "tool/call",
      seq: 4,
      data: {
        turn: 1,
        step: 1,
        callId: "c1",
        name: "bash",
        arguments: '{"cmd":"ls"}',
      },
    },
    {
      type: "tool/result",
      seq: 5,
      data: {
        turn: 1,
        step: 1,
        callId: "c1",
        message: { content: [{ content: [{ type: "text", text: "a.ts" }] }] },
      },
    },
    {
      type: "assistant/message",
      seq: 6,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: "text", text: "看到了" }] },
      },
    },
    {
      type: "turn/end",
      seq: 7,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ]);
  let s = initialState();
  s = reduceState(s, {
    type: "history-restore",
    id: "s1",
    title: "恢复会话",
    rows: surfaceToBuffer(msgs),
  });
  const lines = buildFrame(s, { cols: 80, rows: 24 }).map(rowText);
  const joined = lines.join("\n");
  assert.ok(joined.includes("bash"), `工具名应上屏：${JSON.stringify(lines)}`);
  assert.ok(joined.includes("✓"), "结果符号应上屏");
  assert.ok(joined.includes("看到了"), "正文应上屏");
  assert.ok(
    joined.includes("✓ 跑一下") || joined.includes("跑一下"),
    "用户块应上屏",
  );
});

test("恢复：空 detail 的结果行保留 `✓ ` 尾随空格（前缀契约），批仍配成一组", () => {
  const msgs = normalizeHistoryMessages([
    { type: "step/start", seq: 1, time: 1, data: { turn: 1, step: 1 } },
    {
      type: "tool/call",
      seq: 2,
      data: { turn: 1, step: 1, callId: "c1", name: "write", arguments: "{}" },
    },
    // 结果不带 message（空 detail；静默工具的常态）
    { type: "tool/result", seq: 3, data: { turn: 1, step: 1, callId: "c1" } },
  ]);
  assert.deepEqual(
    msgs.filter((m) => m.role === "tool").map((m) => m.text),
    ["write {}", "✓ "],
    "空 detail 只出 `✓ `（尾随空格是前缀契约）",
  );
  let s = initialState();
  s = reduceState(s, {
    type: "history-restore",
    id: "s1",
    title: "恢复会话",
    rows: surfaceToBuffer(msgs),
  });
  const lines = buildFrame(s, { cols: 80, rows: 24 }).map(rowText);
  const joined = lines.join("\n");
  assert.ok(joined.includes("write"), "调用行应上屏");
  assert.ok(joined.includes("✓"), "结果行应上屏");
});

test("恢复：缺回合号的 turn/end 不覆盖已有终态（沿用旧 turn 的边界）", () => {
  const msgs = normalizeHistoryMessages([
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 2,
      data: { turn: 1, content: [{ type: "text", text: "问题一" }] },
    },
    {
      type: "turn/end",
      seq: 3,
      data: { turn: 1, reason: { kind: "completed" } },
    },
    // 归属不明的收尾事件（无 turn；curTurn 沿用 1）——不得把上面已标的 ✓ 改成 ✗
    { type: "turn/end", seq: 4, data: { reason: { kind: "error" } } },
  ]);
  assert.deepEqual(
    msgs.filter((m) => m.role === "user").map((m) => [m.text, m.status ?? "-"]),
    [["问题一", "success"]],
    "已有终态不被后到的无回合号收尾覆盖",
  );
});
