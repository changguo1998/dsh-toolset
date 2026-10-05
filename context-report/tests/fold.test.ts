/**
 * fold 单测：token 分桶折叠口径（只统计已关闭步、usage 分桶、水位与边界）。
 *
 * 直接驱动 fold.ts 纯函数，事件由 helpers 构造，不依赖宿主运行时与文件系统。
 * 回合 / 步 / 墙钟 / 首 token / 解码口径已移交官方 `sessionStats` 投影
 * （2026-10-06 去重，见 docs/archived/2026-10-05-context-report-official-projections.md），
 * 不在本文件断言。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialState,
  foldSession,
  reduceEvent,
  type FoldScratch,
} from "../src/fold.ts";
import {
  assistantMessage,
  endSeed,
  events,
  stepEnd,
  stepStart,
  typicalSession,
} from "./helpers.ts";

test("空日志：全部计数为 0、水位 -1", () => {
  const state = foldSession([]);
  assert.deepEqual(state, createInitialState());
  assert.equal(state.asOfSeq, -1);
});

test("token 分桶：未缓存输入/输出/缓存读/缓存写/reasoning 分别累计", () => {
  const state = foldSession(typicalSession());
  assert.equal(state.usageSamples, 2, "两次 provider 上报");
  assert.equal(state.uncachedInputTokens, 1_400);
  assert.equal(state.outputTokens, 160);
  assert.equal(state.cacheReadTokens, 50);
  assert.equal(state.cacheWriteTokens, 20);
  assert.equal(state.reasoningTokens, 30, "reasoning 是输出的子集，单独累计");
});

test("缺桶按 0 计：只上报输入/输出也计入样本", () => {
  const state = foldSession(
    events([
      stepStart(1_000),
      assistantMessage(1_100, {
        usage: { inputTokens: 400, outputTokens: 60 },
      }),
      stepEnd(1_150),
    ]),
  );
  assert.equal(state.usageSamples, 1);
  assert.equal(state.uncachedInputTokens, 400);
  assert.equal(state.outputTokens, 60);
  assert.equal(state.cacheReadTokens, 0);
  assert.equal(state.cacheWriteTokens, 0);
  assert.equal(state.reasoningTokens, 0);
});

test("在途步骤不计入：只有 step/start 没有 step/end", () => {
  const state = foldSession(
    events([
      stepStart(1_000),
      assistantMessage(1_500, {
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
    ]),
  );
  assert.equal(state.uncachedInputTokens, 0, "未闭合步不计 token");
  assert.equal(state.outputTokens, 0);
  assert.equal(state.usageSamples, 0);
});

test("usage 全零视为未上报（不产生样本）", () => {
  const state = foldSession(
    events([
      stepStart(1_000),
      assistantMessage(1_100, { usage: { inputTokens: 0, outputTokens: 0 } }),
      stepEnd(1_150),
    ]),
  );
  assert.equal(state.usageSamples, 0);
  assert.equal(state.outputTokens, 0);
});

test("缺失 usage / 异常载荷：跳过样本但不崩、水位仍推进", () => {
  const state = foldSession(
    events([
      stepStart(1_000),
      // usage 形状非法（字符串）
      {
        type: "assistant/message",
        data: { turn: 1, step: 1, usage: "nope" },
        time: 1_200,
      },
      stepEnd(1_250),
      // data 非对象
      { type: "step/end", data: undefined, time: 1_300 },
      // 未知类型
      { type: "unknown/thing", data: { a: 1 }, time: 1_400 },
    ]),
  );
  assert.equal(state.usageSamples, 0);
  assert.equal(state.asOfSeq, 4, "水位推进到末条事件");
});

test("session/end-seed：只推进水位，不改计数", () => {
  const state = foldSession(events([endSeed(1_000)]));
  assert.equal(state.asOfSeq, 0);
  assert.equal(state.usageSamples, 0);
});

test("未匹配事件返回同一引用（宿主据此零下游工作）", () => {
  const state = createInitialState();
  const scratch: FoldScratch = { seq: -1, open: null };
  const unchanged = reduceEvent(
    state,
    { type: "unknown/thing", data: {}, time: 0, seq: 0 },
    scratch,
    0,
  );
  assert.equal(unchanged, state, "未匹配事件不得新建状态对象");
  assert.equal(scratch.seq, 0, "水位仍随事件推进");
});
