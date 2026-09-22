/**
 * fold 单测：事件折叠口径（回合/步计数、墙钟、首 token、解码、token 分桶、配对与边界）。
 *
 * 直接驱动 fold.ts 纯函数，事件由 helpers 构造，不依赖宿主运行时与文件系统。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createInitialState, foldSession } from "../src/fold.ts";
import {
  assistantMessage,
  chunksMessage,
  endSeed,
  events,
  stepEnd,
  stepStart,
  toolCall,
  toolResult,
  typicalSession,
} from "./helpers.ts";

test("空日志：全部计数为 0、水位 -1", () => {
  const state = foldSession([]);
  assert.deepEqual(state, createInitialState());
  assert.equal(state.asOfSeq, -1);
});

test("典型会话：回合/步计数与墙钟口径", () => {
  const state = foldSession(typicalSession());
  assert.equal(state.steps, 2, "step/end 计步数");
  assert.equal(state.turns, 1, "同回合两步只计一次回合");
  assert.equal(
    state.llmMs,
    200 + 300,
    "step/start → assistant/message 墙钟合计",
  );
  assert.equal(state.toolMs, 200, "tool/call → tool/result 墙钟合计");
  assert.equal(state.ttftMs, 500, "无 attempt 前置流时首 token 取消息时间上界");
  assert.equal(state.ttftSteps, 2);
  assert.equal(
    state.decodeMs,
    0,
    "消息即首 token 上界时解码窗口不可分（如实记 0）",
  );
});

test("token 分桶：未缓存输入/输出/缓存读/缓存写/reasoning 分别累计", () => {
  const state = foldSession(typicalSession());
  assert.equal(state.usageSamples, 2, "两次 provider 上报");
  assert.equal(state.uncachedInputTokens, 1_400);
  assert.equal(state.outputTokens, 160);
  assert.equal(state.cacheReadTokens, 50);
  assert.equal(state.cacheWriteTokens, 20);
  assert.equal(state.reasoningTokens, 30, "reasoning 是输出的子集，单独累计");
  assert.equal(
    state.decodeTokens,
    160,
    "带 usage 的步同步累计输出用于算解码速率",
  );
});

test("assistant/attempt 前置流：首 token 与解码窗口生效", () => {
  const state = foldSession(
    events([
      stepStart(1_000),
      {
        type: "assistant/attempt",
        data: {
          turn: 1,
          step: 1,
          stream: [{ type: "text-delta", text: "你" }],
        },
        time: 1_400,
      },
      assistantMessage(1_900, { usage: { inputTokens: 10, outputTokens: 80 } }),
      stepEnd(1_950),
    ]),
  );
  assert.equal(state.ttftMs, 400, "首 token 延迟 = attempt 时间 − step/start");
  assert.equal(state.ttftSteps, 1);
  assert.equal(
    state.decodeMs,
    500,
    "解码窗口 = 消息 − 首 token（前置流早于消息）",
  );
  assert.equal(state.llmMs, 900);
  assert.equal(state.decodeTokens, 80);
});

test("块增量形态（text-chunks/time0）：首 token 精确计，解码窗口可分离", () => {
  const state = foldSession(
    events([
      stepStart(1_000),
      chunksMessage(1_300, {
        time0: 1_100,
        texts: ["你", "好"],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      stepEnd(1_400),
    ]),
  );
  assert.equal(state.ttftMs, 100, "首 token 延迟 = time0 − step/start");
  assert.equal(state.ttftSteps, 1);
  assert.equal(state.decodeMs, 200, "解码窗口 = 消息 − time0");
  assert.equal(state.decodeTokens, 5);
  assert.equal(state.outputTokens, 5);
});

test("块增量形态：attempt 前置时同样按 time0 精确计", () => {
  const state = foldSession(
    events([
      stepStart(1_000),
      {
        type: "assistant/attempt",
        data: {
          turn: 1,
          step: 1,
          stream: [
            { type: "reasoning-chunks", time0: 1_050, dt: [1], texts: ["嗯"] },
          ],
        },
        time: 1_200,
      },
      chunksMessage(1_300, { time0: 1_250, texts: ["答"] }),
      stepEnd(1_400),
    ]),
  );
  assert.equal(state.ttftMs, 50, "attempt 的 time0 优先于消息形态");
  assert.equal(state.decodeMs, 250, "消息 − 首 token（1300−1050）");
});

test("attempt 的空文本增量不算首 token", () => {
  const state = foldSession(
    events([
      stepStart(1_000),
      {
        type: "assistant/attempt",
        data: { turn: 1, step: 1, stream: [{ type: "text-delta", text: "" }] },
        time: 1_300,
      },
      assistantMessage(1_400),
      stepEnd(1_450),
    ]),
  );
  assert.equal(state.ttftMs, 0);
  assert.equal(state.ttftSteps, 0);
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
  assert.equal(state.steps, 0, "未闭合步不计步数");
  assert.equal(state.llmMs, 0, "未闭合步不计墙钟");
  assert.equal(state.uncachedInputTokens, 0, "未闭合步不计 token");
  assert.equal(state.usageSamples, 0);
});

test("回合计数：同回合多步只计一次，跨回合各计一次", () => {
  const state = foldSession(
    events([
      stepStart(1_000, 1, 1),
      assistantMessage(1_100, { turn: 1, step: 1 }),
      stepEnd(1_150, 1, 1),
      stepStart(1_200, 1, 2),
      assistantMessage(1_300, { turn: 1, step: 2 }),
      stepEnd(1_350, 1, 2),
      stepStart(2_000, 2, 1),
      assistantMessage(2_100, { turn: 2, step: 1 }),
      stepEnd(2_150, 2, 1),
    ]),
  );
  assert.equal(state.steps, 3);
  assert.equal(state.turns, 2);
});

test("工具配对：callId 经 message.content 兜底，孤立结果不产生负数", () => {
  const state = foldSession(
    events([
      toolCall(1_000, "call-a"),
      toolResult(1_300, "call-a", { viaContent: true }),
      toolResult(1_400, "call-orphan"),
      toolCall(1_500, "call-b"),
      // call-b 无结果：不计
    ]),
  );
  assert.equal(
    state.toolMs,
    300,
    "内容兜底配对成功，孤立结果与未闭合调用均不参与",
  );
});

test("时间戳倒挂：结果早于调用不计（不产生负数墙钟）", () => {
  const state = foldSession(
    events([toolCall(2_000, "call-x"), toolResult(1_000, "call-x")]),
  );
  assert.equal(state.toolMs, 0);
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
  assert.equal(
    state.steps,
    2,
    "第二条 step/end 也计步（口径与宿主一致：不解析载荷）",
  );
  assert.equal(state.asOfSeq, 4, "水位推进到末条事件");
});

test("缺失时间戳：墙钟样本跳过，计数照常", () => {
  const state = foldSession(
    events([stepStart(0), assistantMessage(0), stepEnd(0)]),
  );
  assert.equal(state.steps, 1);
  assert.equal(state.llmMs, 0, "无时间戳不计墙钟");
  assert.equal(state.turns, 1, "回合身份来自事件载荷（与墙钟无关）");
});

test("session/end-seed：只推进水位，不改计数", () => {
  const state = foldSession(events([endSeed(1_000)]));
  assert.equal(state.steps, 0);
  assert.equal(state.asOfSeq, 0);
});
