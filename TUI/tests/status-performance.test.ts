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

test("B3: 有性能数据 → 状态行渲染 ttfB 与解码速率", () => {
  const out = render({ ttfbMs: 350, avgTokensPerSec: 12.4, streamed: true });
  assert.ok(out.includes("ttfb 350ms"), `应显示 TTFB ms（实际: ${out}）`);
  assert.ok(out.includes("12.4 tok/s"), `应显示解码速率（实际: ${out}）`);
});

test("B3: tTFB >= 1s 显示为秒", () => {
  const out = render({ ttfbMs: 1500, avgTokensPerSec: 8, streamed: true });
  assert.ok(out.includes("ttfb 1.5s"), `1.5s 秒显示（实际: ${out}）`);
});

test("B3: 非流式（无 chunk）→ 无 TTFB, 显示「ttfb —」+ 平均速率", () => {
  const out = render({ avgTokensPerSec: 20.5, streamed: false });
  assert.ok(out.includes("ttfb —"), `非流式应有 ttfB 占位（实际: ${out}）`);
  assert.ok(out.includes("20.5 tok/s"), `非流式也显示平均速率（实际: ${out}）`);
});

test("B3: 无性能数据 → 不渲染性能槽位", () => {
  const out = render(undefined);
  assert.ok(!out.includes("ttfb"), "无性能数据不渲染 ttfB 槽位");
  assert.ok(!out.includes("tok/s"), "无性能数据不渲染速率槽位");
});

test("B3: 高速率保留整数（>=100 tok/s 无小数）", () => {
  const out = render({ ttfbMs: 200, avgTokensPerSec: 123.4, streamed: true });
  assert.ok(out.includes("123 tok/s"), `>=100 取整（实际: ${out}）`);
});
