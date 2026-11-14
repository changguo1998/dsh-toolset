import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusLine } from "../src/app/layout.ts";
import type { FrameRow, FrameSegment } from "../src/renderer/index.ts";

const EMPTY_STATUS = {
  time: "—",
  cwd: "—",
  git: "—",
  model: "—",
  contextLen: "—",
  cacheHit: "—",
};

const USAGE = { input: 100, output: 50, cacheRead: 40, contextWindow: 128000 };

type Judge = {
  state?: "normal" | "stale" | "first" | undefined;
  lastHitRate?: number | undefined;
  runMinHitRate?: number | undefined;
  tolerance: number;
};

/** 状态行所有物理段（按行平铺）。 */
function segmentsOf(
  usage: typeof USAGE | undefined,
  judge?: Judge,
): FrameSegment[] {
  const lines: FrameRow[] = renderStatusLine(
    EMPTY_STATUS,
    120,
    usage,
    undefined,
    undefined,
    undefined,
    judge,
  );
  return lines.flatMap((line) => line.segments);
}

/** cache 段（按文本以 `cache ` 开头定位；无则为 undefined）。 */
function cacheSegOf(
  usage: typeof USAGE | undefined,
  judge?: Judge,
): FrameSegment | undefined {
  return segmentsOf(usage, judge).find((s) => s.text.startsWith("cache "));
}

test("A6: 判定 normal → cache 段绿", () => {
  const seg = cacheSegOf(USAGE, { state: "normal", tolerance: 0.3 });
  assert.equal(
    seg?.style?.fg,
    "green",
    `normal 应着绿（实际: ${seg?.style?.fg}）`,
  );
});

test("A6: 判定 stale → cache 段红", () => {
  const seg = cacheSegOf(USAGE, { state: "stale", tolerance: 0.3 });
  assert.equal(
    seg?.style?.fg,
    "red",
    `stale 应着红（实际: ${seg?.style?.fg}）`,
  );
});

test("A6: 判定 first → cache 段黄", () => {
  const seg = cacheSegOf(USAGE, { state: "first", tolerance: 0.3 });
  assert.equal(
    seg?.style?.fg,
    "yellow",
    `first 应着黄（实际: ${seg?.style?.fg}）`,
  );
});

test("A6: 无判定 → cache 段不着色（默认前景色）", () => {
  const seg = cacheSegOf(USAGE, undefined);
  assert.equal(seg?.text, "cache 29%", `cache 文本不变（实际: ${seg?.text}）`);
  assert.equal(seg?.style, undefined, "无判定不着色");
});

test("A6: 无 usage（`—` 占位）→ 即使有判定也不着色（决策项 11）", () => {
  const segs = segmentsOf(undefined, { state: "stale", tolerance: 0.3 });
  assert.ok(
    segs.some((s) => s.text === "—"),
    "无 usage 时 cache 段保持 `—` 占位",
  );
  const tinted = segs.filter(
    (s) =>
      s.style?.fg === "green" ||
      s.style?.fg === "red" ||
      s.style?.fg === "yellow",
  );
  assert.deepEqual(tinted, [], "占位不着色（无红黄绿段）");
});
