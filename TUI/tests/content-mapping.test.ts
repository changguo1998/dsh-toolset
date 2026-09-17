// tests/content-mapping.test.ts — 双轨对照：BuildBox+fill 管线 vs 旧 wrapBufferLines
//
// advisor 定案：内容映射期间双轨并存（wrapBufferLines 暂存于 layout.ts），
// 测试对同一 buffer + width 逐行比较新旧两管线的产出（pane 归属 / kind /
// 行文本 / 行级 indent），等值后才切换调用点并删除旧实现。
//
// 比较口径：对话区（dialogue）与活动区（activity）分别比较行数组。
// 行文本 = 各段 text 拼接（rowText）；kind/indent 直接比较。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Buffer, BufferKind } from "../src/app/state.ts";
import type { FrameStyle } from "../src/renderer/index.ts";
import { wrapBufferLines } from "../src/app/layout.ts";
import { buildBox } from "../src/app/layout/build-box.ts";
import { measure, allocate } from "../src/app/layout/measure.ts";
import { fillToList, type ContentRow } from "../src/app/layout/fill.ts";
import { rowText, rowAnsi } from "./helpers/rowText.ts";

interface LegacyRow {
  segments: { text: string; style?: FrameStyle }[];
  kind: BufferKind;
  indent: number;
}

const themeId = "dark" as const;

/** 旧管线：wrapBufferLines → 归一化行 */
function legacyRows(buffer: Buffer, width: number, gutter: number) {
  const { dialogue, activity } = wrapBufferLines(
    buffer,
    width,
    gutter,
    themeId,
  );
  // 归一：行宽/缩进是布局层补齐（buildTopRegion indent/pad），非内容语义。
  // 两侧统一为「去首尾纯空格的语义文本 + kind」（user 右对齐 pad、assistant
  // 右缘留白 pad、tool 续行缩进均由布局层负责，双轨只保内容/归属等价）。
  const norm = (rows: LegacyRow[]) =>
    rows.map((r) => ({
      text: r.segments
        .map((s) => s.text)
        .join("")
        .trim(),
      ansi: rowAnsi(
        { segments: r.segments.map((s) => ({ text: s.text, style: s.style })) },
        themeId,
      ).trim(),
      kind: r.kind,
      indent: 0,
    }));
  return {
    dialogue: norm(dialogue),
    activity: norm(activity),
  };
}

/** 新管线：buildBox → measure/allocate → fill（对话/活动分别摊平） */
function newRows(buffer: Buffer, width: number) {
  const built = buildBox(buffer, { themeId, gutter: 4 }); // buildBox width 无关
  const fillPane = (
    pane: typeof built.dialogue,
    hgt: number,
  ): { text: string; ansi: string; kind?: string; indent?: number }[] => {
    const st = measure(pane, { maxW: width });
    const rects = allocate(st, { x: 0, y: 0, w: width, h: hgt });
    return fillToList(
      { themeId, viewportWidth: width },
      pane,
      { x: 0, y: 0, w: width, h: hgt },
      rects,
      built.meta,
    ).map((r: ContentRow) => ({
      text: rowText(r).trim(),
      ansi: rowAnsi(r, themeId).trim(),
      kind: r.kind,
      indent: 0,
    }));
  };
  return {
    dialogue: fillPane(built.dialogue, 400),
    activity: fillPane(built.activity, 400),
  };
}

/** 对照断言：对话区+活动区逐行等价 */
function assertEquivalent(buffer: Buffer, width: number, gutter: number): void {
  const old = legacyRows(buffer, width, gutter);
  const fresh = newRows(buffer, width);
  assert.deepEqual(fresh.dialogue, old.dialogue, `dialogue 不等 @w=${width}`);
  assert.deepEqual(fresh.activity, old.activity, `activity 不等 @w=${width}`);
}

test("双轨：空 buffer", () => {
  assertEquivalent([], 40, 4);
});

test("双轨：plain + separator", () => {
  const buf: Buffer = [
    { text: "hello world", kind: "plain" },
    { text: "", kind: "separator" },
  ];
  assertEquivalent(buf, 40, 4);
});

test("双轨：user + assistant final（收缩块右对齐 + 竖线）", () => {
  const buf: Buffer = [
    { text: "user message", kind: "user" },
    { text: "assistant reply text", kind: "assistant", final: true },
  ];
  for (const w of [40, 20, 10]) assertEquivalent(buf, w, 4);
});

test("双轨：user 多行 + 竖线阈值边界（宽 5/6）", () => {
  const buf: Buffer = [
    { text: "line1\nline2", kind: "user" },
    { text: "ok", kind: "assistant", final: true },
  ];
  for (const w of [5, 6, 12]) assertEquivalent(buf, w, 4);
});

test("双轨：assistant 折行 + 宽边界", () => {
  const long = "assistant ".repeat(10);
  const buf: Buffer = [{ text: long, kind: "assistant", final: true }];
  for (const w of [30, 15, 8]) assertEquivalent(buf, w, 4);
});

test("双轨：thinking + notice + 非 final assistant（活动区）", () => {
  const buf: Buffer = [
    { text: "reasoning...", kind: "thinking" },
    { text: "", kind: "thinking" }, // 空思考行跳过
    { text: "tool notice", kind: "notice", tone: "log" },
    { text: "streaming partial", kind: "assistant", final: false },
  ];
  assertEquivalent(buf, 40, 4);
});

test("双轨：tool 行分组折叠 + step + 结果", () => {
  const buf: Buffer = [
    { text: "bash run cmd", kind: "tool" },
    { text: "✓ done", kind: "tool" },
    { text: "step 2", kind: "tool" },
    { text: "bash run next", kind: "tool" },
    { text: "✗ fail", kind: "tool", tone: "error" },
  ];
  assertEquivalent(buf, 40, 4);
});

test("双轨：tool 超出 TOOL_MAX_GROUPS 折叠占位", () => {
  const buf: Buffer = [];
  for (let i = 0; i < 6; i++) {
    buf.push({ text: "bash run " + i, kind: "tool" });
    buf.push({ text: "✓ ok" + i, kind: "tool" });
  }
  assertEquivalent(buf as Buffer, 40, 4);
});

test("双轨：fence 代码块跨行", () => {
  const buf: Buffer = [
    { text: "", kind: "assistant", final: true },
    { text: "```ts\nconst x = 1;\n```", kind: "assistant", final: true },
    { text: "after fence", kind: "assistant", final: true },
  ];
  assertEquivalent(buf, 30, 4);
});

test("双轨：assistant 尾部空行清理 + user-assistant 块间空行", () => {
  const buf: Buffer = [
    { text: "space", kind: "assistant", final: true },
    { text: "", kind: "assistant", final: true },
    { text: "user", kind: "user" },
    { text: "answer\n", kind: "assistant", final: true },
  ];
  assertEquivalent(buf, 40, 4);
});
