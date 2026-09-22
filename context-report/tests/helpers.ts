// tests/helpers.ts — 测试夹具：构造宿主形态的事件序列（不依赖 dsh 运行时）
//
// 事件形状对齐宿主 dsh-session 的 SessionEventMap（dsh 0.1.5-rc.2）：turn/step 计数、
// assistant/message.usage、tool/call↔tool/result 按 callId 配对、session/end-seed 标记。

import type { ReportEvent } from "../src/types.ts";

/** 一条测试事件的宽松形态（type + data + 可选 time）。 */
export interface FixtureEvent {
  type: string;
  data?: Record<string, unknown>;
  time?: number;
  seq?: number;
}

/** 构造事件数组（自动补 seq）。 */
export function events(list: FixtureEvent[]): ReportEvent[] {
  return list.map((event, index) => ({
    type: event.type,
    data: event.data ?? {},
    time: event.time ?? 0,
    seq: event.seq ?? index,
  }));
}

/** 步起点（t = 基准 + 偏移）。 */
export function stepStart(t: number, turn = 1, step = 1): FixtureEvent {
  return { type: "step/start", data: { turn, step }, time: t };
}

/** 步终点。 */
export function stepEnd(t: number, turn = 1, step = 1): FixtureEvent {
  return { type: "step/end", data: { turn, step }, time: t };
}

/** 助手消息（可带 usage 与内联流记录）。 */
export function assistantMessage(
  t: number,
  opts: {
    turn?: number;
    step?: number;
    usage?: Record<string, number>;
    /** 内联流记录（真实 `assistant/message.stream` 语义）。 */
    stream?: Record<string, unknown>[];
  } = {},
): FixtureEvent {
  const data: Record<string, unknown> = {
    turn: opts.turn ?? 1,
    step: opts.step ?? 1,
    message: { role: "assistant", content: [] },
    stream: opts.stream ?? [],
  };
  if (opts.usage !== undefined) data["usage"] = opts.usage;
  return { type: "assistant/message", data, time: t };
}

/** 块增量形态的消息（宿主 0.1.5-rc.2 实测：`text-chunks` + `time0` + `texts` 数组）。 */
export function chunksMessage(
  t: number,
  opts: {
    turn?: number;
    step?: number;
    /** 首 token 绝对时间（缺省取消息时间）。 */
    time0?: number;
    texts?: string[];
    usage?: Record<string, number>;
  } = {},
): FixtureEvent {
  const data: Record<string, unknown> = {
    turn: opts.turn ?? 1,
    step: opts.step ?? 1,
    message: { role: "assistant", content: [] },
    stream: [
      {
        type: "text-chunks",
        time0: opts.time0 ?? t,
        index: 0,
        dt: [1],
        texts: opts.texts ?? ["好"],
      },
    ],
  };
  if (opts.usage !== undefined) data["usage"] = opts.usage;
  return { type: "assistant/message", data, time: t };
}

/** 工具调用（callId 用于与结果配对）。 */
export function toolCall(
  t: number,
  callId: string,
  name = "bash",
  turn = 1,
  step = 1,
): FixtureEvent {
  return {
    type: "tool/call",
    data: { turn, step, callId, name, arguments: "{}" },
    time: t,
  };
}

/** 工具结果（callId 配对；可测 content 兜底路径）。 */
export function toolResult(
  t: number,
  callId: string | null,
  opts: { viaContent?: boolean; turn?: number; step?: number } = {},
): FixtureEvent {
  const data: Record<string, unknown> = {
    turn: opts.turn ?? 1,
    step: opts.step ?? 1,
    message:
      callId !== null && opts.viaContent === true
        ? {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: callId }],
          }
        : { role: "tool", content: [] },
  };
  if (callId !== null && opts.viaContent !== true) data["callId"] = callId;
  return { type: "tool/result", data, time: t };
}

/** 会话本地起始标记。 */
export function endSeed(t = 0): FixtureEvent {
  return { type: "session/end-seed", data: {}, time: t };
}

/** 典型两回合会话（含工具调用、缓存分桶、往返首 token 与解码窗口）。 */
export function typicalSession(): ReportEvent[] {
  const delta = (text: string): Record<string, unknown>[] => [
    { index: 0, type: "text-delta", text },
  ];
  return events([
    endSeed(1_000),
    stepStart(1_000, 1, 1),
    assistantMessage(1_200, {
      turn: 1,
      step: 1,
      stream: delta("好"),
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 20,
        reasoningTokens: 30,
      },
    }),
    stepEnd(1_250, 1, 1),
    toolCall(1_300, "call-1"),
    toolResult(1_500, "call-1"),
    stepStart(1_600, 1, 2),
    assistantMessage(1_900, {
      turn: 1,
      step: 2,
      stream: delta("答"),
      usage: { inputTokens: 400, outputTokens: 60 },
    }),
    stepEnd(1_950, 1, 2),
  ]);
}

/** 构造常见状态（供报告用例直接注入）。 */
export function stateFixture(
  overrides: Partial<import("../src/types.ts").SessionContextState> = {},
): import("../src/types.ts").SessionContextState {
  return {
    asOfSeq: 10,
    turns: 1,
    steps: 2,
    llmMs: 500,
    toolMs: 200,
    ttftMs: 200,
    ttftSteps: 2,
    decodeMs: 300,
    decodeTokens: 160,
    uncachedInputTokens: 1_400,
    outputTokens: 160,
    cacheReadTokens: 50,
    cacheWriteTokens: 20,
    reasoningTokens: 30,
    usageSamples: 2,
    ...overrides,
  };
}
