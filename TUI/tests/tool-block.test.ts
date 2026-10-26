// tests/tool-block.test.ts — 回合区工具块形制（2026-10-13 改版；2026-10-26 迁新链）
//
// 裁定见 TUI/docs/implementation/2026-10-13-tool-block-display.md（决策 1 / 8 + 细节 01-11）。
// 覆盖（均走新流水线）：参数解析兜底、结果配对（callId / 到达顺序）、静默工具、
// 并发多调用各出一行标记、帧层在飞相位标记。
//
// 已删：旧渲染栈（`buildContentRows`）的「三类行缩进 4 / 6 / 2、值 5 行上限、名字截断、
// 长名取舍」用例——那些是旧实现的行内截断/缩进参数，新链的工具行形制由
// `pipeline-structure`（行盒形制）与 `pipeline-flatten`（网格）覆盖。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame, displayWidth, rowText } from "../src/app/layout.ts";
import { pipelineContent } from "../src/app/layout/pipeline/frame.ts";
import { toolParams } from "../src/app/adapter/normalize.ts";
import {
  initialState,
  type AppState,
  type HistoryRow,
} from "../src/app/state.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import { sectionsFromScript } from "./helpers/deliveriesFromScript.ts";

const W = 40;
const T0 = new Date(2026, 0, 2, 3, 4, 5).getTime();

/** 交付脚本 → 活动 pane 行文本（去掉 step 头行） */
const pipeline = (script: BlockDelivery[]): string[] =>
  pipelineContent(
    sectionsFromScript(script.map((delivery) => ({ delivery }))),
    {
      dialogueTextW: 60,
      activityTextW: 60,
      windowGroups: 10,
      render: { width: 60 },
    },
  )
    .activity.map((row) => rowText(row))
    .map((text) => text.replace(/^┃+/, "").replace(/ +$/, ""))
    .filter((text) => !text.startsWith("╌╌"));

/** 去掉 turn / step 的交付类型（分布式 Omit：保留联合各分支的判别字段） */
type NoScope<T> = T extends unknown ? Omit<T, "turn" | "step"> : never;

/** 一步脚本：step 声明 + 若干工具交付 */
const step = (...deliveries: NoScope<BlockDelivery>[]): BlockDelivery[] => [
  { kind: "step-start", turn: 1, step: 1, time: T0 },
  ...deliveries.map((d) => ({ ...d, turn: 1, step: 1 }) as BlockDelivery),
];

test("toolParams：JSON 原序取值；非对象 / 解析失败 → 单条无名兜底", () => {
  assert.deepEqual(toolParams('{"path":"a","limit":100}'), [
    { name: "path", value: "a" },
    { name: "limit", value: "100" },
  ]);
  assert.deepEqual(toolParams('{"obj":{"a":1},"ok":true}'), [
    { name: "obj", value: '{"a":1}' },
    { name: "ok", value: "true" },
  ]);
  assert.deepEqual(toolParams("ls -la"), [{ name: "", value: "ls -la" }]);
  assert.deepEqual(toolParams("[1,2]"), [{ name: "", value: "[1,2]" }]);
  assert.deepEqual(toolParams("{不是 JSON"), [
    { name: "", value: "{不是 JSON" },
  ]);
});

test("配对：callId 优先（结果乱序到达也能对上成败标记）", () => {
  const out = pipeline(
    step(
      {
        kind: "tool-call",
        callId: "a",
        name: "read",
        args: '{"path":"p1"}',
        full: true,
      },
      {
        kind: "tool-call",
        callId: "b",
        name: "grep",
        args: '{"pattern":"p2"}',
        full: true,
      },
      { kind: "tool-result", callId: "b", ok: false, detail: "no match" },
      { kind: "tool-result", callId: "a", ok: true, detail: "ok1" },
    ),
  );
  // 结果紧跟各自的调用（ToolBatch 产序：名字行 → 参数行 → 该调用的结果行）
  assert.deepEqual(out, [
    "✓ read",
    "    path p1",
    "  ok1",
    "✗ grep",
    "    pattern p2",
    "  no match",
  ]);
});

test("配对：缺 callId → 按到达顺序；并发多调用各出一行标记", () => {
  const out = pipeline(
    step(
      { kind: "tool-call", callId: "c1", name: "read", args: "a", full: true },
      { kind: "tool-call", callId: "c2", name: "grep", args: "b", full: true },
      { kind: "tool-result", ok: true, detail: "r1" },
      { kind: "tool-result", ok: false, detail: "r2" },
    ),
  );
  // 缺 callId 的结果按到达顺序配给未配对调用，配对后仍紧跟各自调用
  assert.deepEqual(out, ["✓ read", "    a", "  r1", "✗ grep", "    b", "  r2"]);
  // 三个在飞调用 → 三行名字行（各带独立标记）
  const pending = pipeline(
    step(
      { kind: "tool-call", callId: "p1", name: "read", args: "a", full: true },
      { kind: "tool-call", callId: "p2", name: "grep", args: "b", full: true },
      { kind: "tool-call", callId: "p3", name: "bash", args: "c", full: true },
    ),
  );
  assert.deepEqual(pending, [
    "● read",
    "    a",
    "● grep",
    "    b",
    "● bash",
    "    c",
  ]);
});

test("静默工具（空结果）不挂结果行；有 `(+N/-M)` 摘要的空详情仍挂", () => {
  const silent = pipeline(
    step(
      {
        kind: "tool-call",
        callId: "s1",
        name: "write",
        args: '{"path":"a.ts"}',
        full: true,
      },
      { kind: "tool-result", callId: "s1", ok: true, detail: "" },
    ),
  );
  assert.deepEqual(silent, ["✓ write", "    path a.ts"]);
  const diffed = pipeline(
    step(
      {
        kind: "tool-call",
        callId: "s2",
        name: "hash_edit",
        args: '{"file":"a.ts"}',
        full: true,
      },
      {
        kind: "tool-result",
        callId: "s2",
        ok: true,
        detail: "",
        meta: { before: "a", after: "a\nb" },
      },
    ),
  );
  assert.deepEqual(diffed, ["✓ hash_edit", "    file a.ts", "  (+1/-0)"]);
});

test("帧层相位标记：活跃 → ●/○；已不活跃且无结果 → ■；完成 → ✓（管线写死）", () => {
  const script = step({
    kind: "tool-call",
    callId: "f1",
    name: "read",
    args: '{"path":"p"}',
    full: true,
  });
  const base = {
    ...initialState(),
    pipeline: sectionsFromScript(script.map((delivery) => ({ delivery }))),
  };
  const frame = (s: AppState): string =>
    buildFrame(s, { rows: 24, cols: 60 })
      .map((row) => rowText(row))
      .join("\n");
  const running = frame({
    ...base,
    agentStatus: "tool",
    inputStatus: "running",
  } as AppState);
  assert.ok(/[●○] read/.test(running), "活跃 → ●/○ 相位: " + running);
  const idle = frame({
    ...base,
    agentStatus: "idle",
    inputStatus: "idle",
  } as AppState);
  assert.ok(idle.includes("■ read"), "不活跃且无结果 → ■: " + idle);
  const done = frame({
    ...base,
    pipeline: sectionsFromScript(
      step(
        {
          kind: "tool-call",
          callId: "f1",
          name: "read",
          args: '{"path":"p"}',
          full: true,
        },
        { kind: "tool-result", callId: "f1", ok: true, detail: "ok" },
      ).map((delivery) => ({ delivery })),
    ),
    agentStatus: "idle",
    inputStatus: "idle",
  } as AppState);
  assert.ok(done.includes("✓ read"), "完成 → ✓ 且帧层不改写: " + done);
});
