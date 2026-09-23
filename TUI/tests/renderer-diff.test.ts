// tests/renderer-diff.test.ts — Renderer 区间 diff（帧中任意位置变化只重写该区间）
//
// 覆盖：中部单行变化（状态栏符号）、末行行内增长（流式）、纯追加、行数减少
// （尾部残留 ESC[J 清除）、两帧一致不出报文、未变化行不重写。
// 关键不变量：增量帧不得出现 ESC[2J（清屏）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderer, type FrameRow } from "../src/renderer/index.ts";

function row(text: string): FrameRow {
  return { segments: [{ text }] };
}

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

test("区间 diff：中部单行变化只重写该行（状态栏符号，无清屏）", () => {
  const { chunks, renderer } = collector();
  const frame = (sym: string): FrameRow[] => [
    ...Array.from({ length: 34 }, (_, i) => row(`content ${i}`)),
    row(`status ${sym}`),
    row("> input"),
  ];
  renderer.render(frame("●"));
  const mark = chunks.length;
  renderer.render(frame("○"));
  const out = chunks.slice(mark).join("");
  assert.ok(!out.includes("\x1b[2J"), "增量帧不得清屏");
  assert.ok(
    out.startsWith("\x1b[?2026h\x1b[35;1H"),
    "应绝对定位到第 35 行（状态行）",
  );
  assert.ok(out.includes("status ○"), "应重写变化行");
  assert.ok(!out.includes("content 33"), "未变化行不重写");
  assert.ok(!out.includes("> input"), "变化行之后的未变化行不重写");
  renderer.close();
});

test("区间 diff：流式末行行内增长只重写末行", () => {
  const { chunks, renderer } = collector();
  const frame = (text: string): FrameRow[] => [
    ...Array.from({ length: 5 }, (_, i) => row(`line ${i}`)),
    row(text),
  ];
  renderer.render(frame("assistant: "));
  const mark = chunks.length;
  renderer.render(frame("assistant: 你好"));
  const out = chunks.slice(mark).join("");
  assert.ok(!out.includes("\x1b[2J"), "增量帧不得清屏");
  assert.ok(out.startsWith("\x1b[?2026h\x1b[6;1H"), "应定位到第 6 行（末行）");
  assert.ok(out.includes("assistant: 你好"), "应重写末行新内容");
  assert.ok(!out.includes("line 4"), "前文不重写");
  renderer.close();
});

test("区间 diff：纯追加新行只写追加行", () => {
  const { chunks, renderer } = collector();
  const frame = (n: number): FrameRow[] =>
    Array.from({ length: n }, (_, i) => row(`line ${i}`));
  renderer.render(frame(6));
  const mark = chunks.length;
  renderer.render(frame(7));
  const out = chunks.slice(mark).join("");
  assert.ok(!out.includes("\x1b[2J"), "增量帧不得清屏");
  assert.ok(
    out.startsWith("\x1b[?2026h\x1b[7;1H"),
    "应定位到第 7 行（新增行）",
  );
  assert.ok(out.includes("line 6"), "应写入新增行");
  assert.ok(!out.includes("line 0"), "既有行不重写");
  renderer.close();
});

test("区间 diff：行数减少时清除下方残留（ESC[J）", () => {
  const { chunks, renderer } = collector();
  const frame = (n: number): FrameRow[] =>
    Array.from({ length: n }, (_, i) => row(`line ${i}`));
  renderer.render(frame(7));
  const mark = chunks.length;
  renderer.render(frame(5)); // 删除第 6、7 行
  const out = chunks.slice(mark).join("");
  assert.ok(!out.includes("\x1b[2J"), "增量帧不得清屏");
  assert.ok(out.includes("\x1b[J"), "应清除区间下方残留行");
  assert.ok(
    out.startsWith("\x1b[?2026h\x1b[6;1H"),
    "变化区间自第 6 行起（原第 6 行起被删除）",
  );
  assert.ok(
    out.includes("\x1b[6;1H\x1b[J"),
    "区间为空时清除定位即残留首行（第 6 行）",
  );
  renderer.close();
});

test("区间 diff：两帧一致时不出报文", () => {
  const { chunks, renderer } = collector();
  const frame = (): FrameRow[] => [
    ...Array.from({ length: 10 }, (_, i) => row(`line ${i}`)),
  ];
  renderer.render(frame());
  const mark = chunks.length;
  renderer.render(frame());
  assert.equal(chunks.length, mark, "无变化不应写终端");
  renderer.close();
});

test("区间 diff：caret 变化（输入行）触发该行重写", () => {
  const { chunks, renderer } = collector();
  const frame = (caret: number): FrameRow[] => [
    ...Array.from({ length: 3 }, (_, i) => row(`line ${i}`)),
    { segments: [{ text: "> ab" }], caret },
  ];
  renderer.render(frame(3));
  const mark = chunks.length;
  renderer.render(frame(4));
  const out = chunks.slice(mark).join("");
  assert.ok(!out.includes("\x1b[2J"), "增量帧不得清屏");
  assert.ok(out.startsWith("\x1b[?2026h\x1b[4;1H"), "应定位到输入行");
  assert.ok(out.includes("\x1b[4;5H"), "光标应落到新 caret 列");
  renderer.close();
});

// 帧段表（top/status/footer/hint 行带）用于把变化区间按段切分：
// 多段同时变化时只重写各段内的变化行，不跨越中间未变化的段。
const SECTIONS = [
  { id: "top" as const, startLine: 0, lineCount: 5 },
  { id: "status" as const, startLine: 5, lineCount: 2 },
  { id: "footer" as const, startLine: 7, lineCount: 2 },
  { id: "hint" as const, startLine: 9, lineCount: 1 },
];

function sectionFrame(topText: string, sym: string): FrameRow[] {
  return [
    row(topText),
    row("t1"),
    row("t2"),
    row("t3"),
    row("t4"),
    row("sep"),
    row(`status ${sym}`),
    row("> input"),
    row(""),
    row("hint"),
  ];
}

test("帧段切分：top 与 status 两段同时变化只重写各自段内变化行", () => {
  const { chunks, renderer } = collector();
  renderer.render(sectionFrame("top A", "●"), SECTIONS);
  const mark = chunks.length;
  renderer.render(sectionFrame("top B", "○"), SECTIONS);
  const out = chunks.slice(mark).join("");
  assert.ok(!out.includes("\x1b[2J"), "增量帧不得清屏");
  // 两个独立区间：top 段第 1 行、status 段状态栏行（第 7 行）
  assert.ok(out.includes("\x1b[1;1H"), "top 段区间应定位第 1 行");
  assert.ok(out.includes("\x1b[7;1H"), "status 段区间应定位第 7 行");
  assert.ok(out.includes("top B"), "重写 top 变化行");
  assert.ok(out.includes("status ○"), "重写状态栏变化行");
  assert.ok(!out.includes("t1"), "段内未变化行不重写");
  assert.ok(!out.includes("> input"), "footer 段未变化不重写");
  assert.ok(!out.includes("hint"), "hint 段未变化不重写");
  renderer.close();
});

test("帧段切分：段表不一致时退化为整帧单一区间（不漏更新）", () => {
  const { chunks, renderer } = collector();
  renderer.render(sectionFrame("top A", "●"), SECTIONS);
  const mark = chunks.length;
  // 第二帧段表不同（如几何变化）→ 退化整帧比较，变化区间覆盖首末变化行
  const other = SECTIONS.map((s) => ({ ...s }));
  other[0] = { id: "top", startLine: 0, lineCount: 6 };
  renderer.render(sectionFrame("top B", "○"), other);
  const out = chunks.slice(mark).join("");
  assert.ok(!out.includes("\x1b[2J"), "增量帧不得清屏");
  assert.ok(out.includes("top B"), "重写首变化行");
  assert.ok(out.includes("status ○"), "重写末变化行");
  renderer.close();
});

test("帧段切分：段内变化行数少于整段时只重写变化行", () => {
  const { chunks, renderer } = collector();
  renderer.render(sectionFrame("top A", "●"), SECTIONS);
  const mark = chunks.length;
  const next = sectionFrame("top A", "●");
  next[3] = row("t3 changed"); // top 段中间一行变化
  renderer.render(next, SECTIONS);
  const out = chunks.slice(mark).join("");
  assert.ok(
    out.startsWith("\x1b[?2026h\x1b[4;1H"),
    "只定位到变化行（第 4 行）",
  );
  assert.ok(out.includes("t3 changed"), "重写变化行");
  assert.ok(!out.includes("t1"), "同段未变化行不重写");
  renderer.close();
});
