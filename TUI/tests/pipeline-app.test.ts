// tests/pipeline-app.test.ts — App 级接管等价：同一条事件序列两条路径逐帧一致
//
// 与 `pipeline-frame.test.ts` 的区别：这里走**真实 App 装配**（sink 注册 → 接收 → 节缓存 →
// state.pipeline → buildTopRegion → 帧），逐步（流式增量 / 工具 / notice / 回合结束）比对
// 「旧缓冲路径」与「六步流水线路径」的整帧输出，覆盖真实帧循环与会话状态。
//
// App 缺 `pipelineSink` 时不接管（旧路径）；本用例两侧各建一个 App，事件与块交付同步喂入。

import { test } from "node:test";
import assert from "node:assert/strict";

import { App } from "../src/app/index.ts";
import type { DshEvent } from "../src/app/adapter/dsh.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import {
  applyDelivery,
  createSections,
} from "../src/app/layout/pipeline/sections.ts";
import { clearBuffer, initialState, reduceState } from "../src/app/state.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { flushApp, registerApp } from "./helpers/paintFlush.ts";

/** 一条测试步：老路径事件 + 新路径块交付（同一内容） */
interface Step {
  readonly event: DshEvent;
  readonly delivery?: BlockDelivery;
}

const TURN = 1;
const TIME = new Date(2026, 0, 2, 3, 4, 5).getTime();

/** 语料：step 头 → 思考 → 工具批 → 正文（含代码块） → notice → 回合结束 */
function script(): Step[] {
  return [
    {
      event: {
        type: "step",
        sessionId: "s1",
        turn: TURN,
        step: 1,
        phase: "start",
        time: TIME,
      },
      delivery: { kind: "step-start", turn: TURN, step: 1, time: TIME },
    },
    {
      // 宿主 turn/start：回填回合号（分隔线 ⇆N）。无交付——流水线的 turn-start
      // 由 App 在 turn-begin（首条内容）时同步交付（时间的真源）。
      event: { type: "turn-start", turn: TURN },
    },
    {
      event: { type: "thinking", sessionId: "s1", text: "（先读文档）" },
      delivery: {
        kind: "text",
        turn: TURN,
        step: 1,
        index: 1,
        source: "reasoning",
        text: "（先读文档）",
      },
    },
    {
      event: {
        type: "tool-call",
        sessionId: "s1",
        name: "read",
        summary: "/tmp/a.md",
        callId: "c1",
      },
      delivery: {
        kind: "tool-call",
        turn: TURN,
        step: 1,
        callId: "c1",
        name: "read",
        args: "/tmp/a.md",
        full: true,
      },
    },
    {
      event: { type: "tool-result", sessionId: "s1", ok: true, detail: "ok" },
      delivery: {
        kind: "tool-result",
        turn: TURN,
        step: 1,
        callId: "c1",
        ok: true,
        detail: "ok",
      },
    },
    {
      event: { type: "stream", sessionId: "s1", text: "要点：" },
      delivery: {
        kind: "text",
        turn: TURN,
        step: 1,
        index: 0,
        source: "assistant",
        text: "要点：",
      },
    },
    {
      event: { type: "stream", sessionId: "s1", text: "```ts" },
      delivery: {
        kind: "text",
        turn: TURN,
        step: 1,
        index: 0,
        source: "assistant",
        text: "```ts",
      },
    },
    {
      event: { type: "stream", sessionId: "s1", text: "const a = 1;" },
      delivery: {
        kind: "text",
        turn: TURN,
        step: 1,
        index: 0,
        source: "assistant",
        text: "const a = 1;",
      },
    },
    {
      event: { type: "stream", sessionId: "s1", text: "```" },
      delivery: {
        kind: "text",
        turn: TURN,
        step: 1,
        index: 0,
        source: "assistant",
        text: "```",
      },
    },
    {
      event: { type: "notice", text: "（压缩完成）", tone: "info" },
      delivery: { kind: "notice", text: "（压缩完成）", tone: "info" },
    },
    {
      event: { type: "turn-end", reason: "completed" },
      delivery: { kind: "turn-end", turn: TURN, step: 1 },
    },
  ];
}

/** 建一个 App；`pipeline` = 是否注入 sink（接管开关） */
function makeApp(pipeline: boolean): {
  app: App;
  renderer: FakeRenderer;
  adapter: FakeAdapter;
  sink: { current?: (delivery: BlockDelivery) => void };
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const sink: { current?: (delivery: BlockDelivery) => void } = {};
  const app = new App({
    renderer,
    adapter,
    ...(pipeline ? { pipelineSink: sink } : {}),
  });
  registerApp(app);
  app.start();
  return { app, renderer, adapter, sink };
}

/**
 * 取当前帧（先 paintNow 再冲刷 renderer 合帧，与生产帧循环口径一致）。
 * `⇆N` 回合号做归一：旧路径的分隔线回合号靠宿主 turn/start 回填（晚一帧），
 * 流水线在 turn-begin 交付时即带号——这是唯一已知的瞬时差异，归一后比对其余全部。
 */
const frames = (app: App, renderer: FakeRenderer): string[] => {
  app.paintNow();
  flushApp();
  return renderer.lastRender.map((line) =>
    line
      .replace(/\x1b\[[0-9;]*m/g, "")
      // 回合分隔线整行归一：旧路径的回合号靠宿主 turn/start 回填（晚一帧），
      // 流水线在 turn-begin 交付时即带号——唯一已知的瞬时差异，其余逐行比对
      .replace(/╌╌ [0-9:]+ (⇆\d+ )?╌*$/, "SEP"),
  );
};

test("逐步等价：App 装配下新旧路径每一步的整帧输出一致", () => {
  const old = makeApp(false);
  const next = makeApp(true);
  for (const [index, step] of script().entries()) {
    // 真实运行形态：adapter 同时发事件（旧路径 / 状态面）与块交付（六步流水线）
    old.adapter.push(step.event);
    next.adapter.push(step.event);
    if (step.delivery !== undefined) next.sink.current?.(step.delivery);
    assert.deepEqual(
      frames(next.app, next.renderer),
      frames(old.app, old.renderer),
      `第 ${index + 1} 步（${step.event.type}）`,
    );
  }
  old.app.dispose();
  next.app.dispose();
});

test("接管开关：无 sink 的 App 不注入节缓存（回落旧路径）", () => {
  const old = makeApp(false);
  old.adapter.push({ type: "stream", sessionId: "s1", text: "只有旧路径" });
  // 未接管：sink 容器保持为空（App 不注册），帧内容仍来自旧缓冲路径
  assert.equal(old.sink.current, undefined, "未接管时不注册 sink");
  assert.ok(frames(old.app, old.renderer).join("").includes("只有旧路径"));
  old.app.dispose();
});

test("接管开关：有 sink 的 App 注入节缓存并按块交付出帧", () => {
  const next = makeApp(true);
  next.sink.current?.({
    kind: "text",
    turn: 1,
    step: 1,
    index: 0,
    source: "assistant",
    text: "来自节缓存",
    full: true,
  });
  assert.ok(next.sink.current !== undefined, "接管时注册了 sink");
  assert.ok(
    frames(next.app, next.renderer).join("").includes("来自节缓存"),
    "节缓存内容进入帧",
  );
  next.app.dispose();
});

test("接管开关：/cls（clearBuffer）清空节缓存，旧内容不再复现", () => {
  const next = makeApp(true);
  next.sink.current?.({
    kind: "text",
    turn: 1,
    step: 1,
    index: 0,
    source: "assistant",
    text: "将被清掉",
    full: true,
  });
  assert.ok(frames(next.app, next.renderer).join("").includes("将被清掉"));
  const seeded = initialState();
  const withPipeline = {
    ...seeded,
    buffer: [{ text: "将被清掉", kind: "assistant" as const }],
    pipeline: applyDelivery(createSections(), {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant" as const,
      text: "将被清掉",
      full: true,
    }),
  };
  const cleared = clearBuffer(withPipeline);
  assert.equal(cleared.pipeline?.sections.length ?? -1, 0, "清屏后节缓存为空");
  assert.equal(cleared.buffer.length, 0, "缓冲同源清空");
  next.app.dispose();
});

test("接管开关：/new（session-switch）归零节缓存", () => {
  const seeded = {
    ...initialState(),
    buffer: [{ text: "旧会话内容", kind: "assistant" as const }],
    pipeline: applyDelivery(createSections(), {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant" as const,
      text: "旧会话内容",
      full: true,
    }),
  };
  const switched = reduceState(seeded, {
    type: "session-switch",
    id: "s-new",
    title: "新会话",
  });
  assert.equal(
    switched.pipeline?.sections.length ?? -1,
    0,
    "切换后节缓存为空（否则首帧渲染旧会话内容）",
  );
  assert.equal(switched.buffer.length, 0);
});
