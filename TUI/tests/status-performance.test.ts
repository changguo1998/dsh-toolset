import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusLine } from "../src/app/layout.ts";
import type { FrameRow } from "../src/renderer/index.ts";

const EMPTY_STATUS = {
  time: "—",
  cwd: "—",
  git: "—",
  model: "—",
  contextLen: "—",
  cacheHit: "—",
};

/** 状态行文本（FrameRow 段拼接, 去掉首尾留边空格）。 */
function lineText(lines: FrameRow[]): string[] {
  return lines.map((l) =>
    l.segments
      .map((s) => s.text)
      .join("")
      .replace(/^\s+|\s+$/g, ""),
  );
}

function render(performance?: {
  ttfbMs?: number | undefined;
  avgTokensPerSec?: number | undefined;
  streamed: boolean;
}): string {
  return lineText(
    renderStatusLine(
      EMPTY_STATUS,
      120,
      { input: 100, output: 50, cacheRead: 40, contextWindow: 128000 },
      undefined,
      undefined,
      performance,
    ),
  ).join("\n");
}

test("B3: 有读数 → 时间 + 速率, 不带 ttfb 标签", () => {
  const out = render({ ttfbMs: 350, avgTokensPerSec: 12.4, streamed: true });
  assert.ok(
    out.includes(" 350 ms 12.4 t/s"),
    `应显示 时间 + 速率（实际: ${out}）`,
  );
  assert.ok(!out.includes("ttfb"), "不再写 ttfb 标签");
});

test("B3: 延时 >= 1s 改用秒", () => {
  const out = render({ ttfbMs: 1500, avgTokensPerSec: 8, streamed: true });
  assert.ok(out.includes(" 1.5 s 8.0 t/s"), `大延时用秒（实际: ${out}）`);
});

test("B3: 无读数 → 常驻 0ms 0 t/s 占位", () => {
  const out = render(undefined);
  assert.ok(out.includes("   0 ms 0 t/s"), `无读数应显示零值（实际: ${out}）`);
});

test("B3: 该步收尾归零 → 0ms 0 t/s（不保留已结束读数）", () => {
  const out = render({ ttfbMs: 0, avgTokensPerSec: 0, streamed: true });
  assert.ok(out.includes("   0 ms 0 t/s"), `收尾应归零（实际: ${out}）`);
});

test("B3: 高速率保留整数（>=100 无小数）", () => {
  const out = render({ ttfbMs: 200, avgTokensPerSec: 123.4, streamed: true });
  assert.ok(out.includes(" 200 ms 123 t/s"), `>=100 取整（实际: ${out}）`);
});

test("B3: ttfb 数字右对齐补足 4 字符宽（两位数补位）", () => {
  const out = render({ ttfbMs: 12, avgTokensPerSec: 5, streamed: true });
  assert.ok(out.includes("  12 ms 5.0 t/s"), `两位数补位（实际: ${out}）`);
});
