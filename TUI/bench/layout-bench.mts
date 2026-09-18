// TUI/bench/layout-bench.mts — 排版性能基准（手动运行：npm --prefix TUI run bench）
//
// 口径：固定合成语料 + 固定列宽，同一进程内分别以 cache off / cache on 跑
// buildFrame，打印中位耗时与提速倍数。三档用同一份状态：
//   cold        每帧前清空缓存（首屏 / 每帧内容全新）——off 档即优化前基线
//   warm        同一状态重复排版（无变化帧：状态栏 ticker 等）
//   incremental 增量追加尾行（流式追尾，最接近真实负载）
// 不设失败阈值（退出码恒 0）：数字供人工与验收合同复核，不进常规测试。
//
// 语料确定性：固定种子线性同余发生器，不用 Math.random。

import { initialState, reduceState, type AppState } from "../src/app/state.ts";
import { buildFrame } from "../src/app/layout.ts";
import {
  clearLayoutCaches,
  setLayoutCacheEnabled,
} from "../src/app/layout/cache.ts";

const SIZE = { cols: 120, rows: 40 };
const ITERS = 30;
const BASE_LINES = 1000;

/** 固定种子线性同余发生器（确定性伪随机） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 合成语料：用户行/思考/正文（含 markdown）/工具行/notice 按固定比例交错 */
function synthState(lines: number): AppState {
  const rand = lcg(20260918);
  let s = initialState();
  for (let i = 0; i < lines; i++) {
    const kind = i % 9;
    if (kind === 0) {
      s = reduceState(s, { type: "user-line", text: `问题 ${i}：第 ${i} 轮需求描述` });
    } else if (kind === 1 || kind === 2) {
      s = reduceState(s, {
        type: "thinking",
        text: `思考 ${i}：`.padEnd(40 + Math.floor(rand() * 60), "思"),
      });
    } else if (kind === 3 || kind === 4) {
      s = reduceState(s, {
        type: "append",
        text:
          `回复 ${i}：` +
          "正文段落".repeat(20) +
          (i % 18 === 0 ? "\n- 列表项 **粗体** 与 `code`" : ""),
      });
    } else if (kind === 5) {
      s = reduceState(s, {
        type: "tool-call",
        sessionId: "bench",
        name: "read",
        summary: `src/app/file-${i}.ts`,
      });
    } else if (kind === 6) {
      s = reduceState(s, {
        type: "tool-result",
        sessionId: "bench",
        ok: i % 3 !== 0,
        detail: `工具结果 ${i}：`.padEnd(60, "结"),
      });
    } else {
      s = reduceState(s, { type: "notice", text: `通知 ${i}` });
    }
  }
  return s;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 计时一档（每帧取样一次，返回中位耗时 ms） */
function measure(fn: () => void, iters: number): number {
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

interface Row {
  mode: string;
  off: number;
  on: number;
}

const rows: Row[] = [];

// ---- cold：每帧前清空缓存 ----
{
  const state = synthState(BASE_LINES);
  setLayoutCacheEnabled(false);
  const off = measure(() => {
    clearLayoutCaches();
    buildFrame(state, SIZE);
  }, ITERS);
  setLayoutCacheEnabled(true);
  const on = measure(() => {
    clearLayoutCaches();
    buildFrame(state, SIZE);
  }, ITERS);
  rows.push({ mode: "cold", off, on });
}

// ---- warm：同一状态重复排版 ----
{
  const state = synthState(BASE_LINES);
  setLayoutCacheEnabled(false);
  clearLayoutCaches();
  const off = measure(() => void buildFrame(state, SIZE), ITERS);
  setLayoutCacheEnabled(true);
  clearLayoutCaches();
  buildFrame(state, SIZE); // 预热一次（缓存填充不计入）
  const on = measure(() => void buildFrame(state, SIZE), ITERS);
  rows.push({ mode: "warm", off, on });
}

// ---- incremental：增量追加尾行 ----
{
  setLayoutCacheEnabled(false);
  let offState = synthState(BASE_LINES);
  clearLayoutCaches();
  const off = measure(() => {
    offState = reduceState(offState, {
      type: "append",
      text: `增量追加：${offState.buffer.length} 行，正文段落`.padEnd(80, "文"),
    });
    buildFrame(offState, SIZE);
  }, ITERS);
  setLayoutCacheEnabled(true);
  let onState = synthState(BASE_LINES);
  clearLayoutCaches();
  buildFrame(onState, SIZE); // 预热：稳态下缓存已装填
  const on = measure(() => {
    onState = reduceState(onState, {
      type: "append",
      text: `增量追加：${onState.buffer.length} 行，正文段落`.padEnd(80, "文"),
    });
    buildFrame(onState, SIZE);
  }, ITERS);
  rows.push({ mode: "incremental", off, on });
}

// ---- 报告 ----
const speedup = (r: Row): string => (r.off / r.on).toFixed(1) + "×";
console.log(
  `buildFrame 基准｜cols=${SIZE.cols} rows=${SIZE.rows} buffer≈${BASE_LINES} 行｜iterations=${ITERS}`,
);
console.log("mode          cache off      cache on      speedup");
for (const r of rows) {
  console.log(
    `${r.mode.padEnd(13)} ${(r.off.toFixed(2) + " ms").padEnd(14)} ${(r.on.toFixed(2) + " ms").padEnd(13)} ${speedup(r)}`,
  );
}
console.log(
  `注：cache off = 优化前路径（TUI_LAYOUT_CACHE=0 等价）；数字随机器与语料浮动，仅作报告，不设阈值。`,
);
console.log(`node ${process.version}`);
process.exitCode = 0;
