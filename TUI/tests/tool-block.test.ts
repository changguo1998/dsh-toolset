// tests/tool-block.test.ts — 回合区工具块形制（2026-10-13 改版）
//
// 裁定见 TUI/docs/implementation/2026-10-13-tool-block-display.md（决策 1 / 8 + 细节 01-11）。
// 覆盖：名字行形制与三类行缩进（4 / 6 / 2）、完成 / 失败 / 静默、在飞两相位与 `■`、
// 值 5 行上限、名字截断、长名取舍（另起 vs 同行）、非 JSON 参数兜底、
// 结果配对（callId 与到达顺序两种）、并发多调用各出一行标记。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContentRows } from "../src/app/layout/build-box.ts";
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

/** 三类行渲染文本（活动 pane；宽度 = W） */
const act = (rows: HistoryRow[], width = W): string[] =>
  buildContentRows(rows, {}, width, width).activity.map((r) => rowText(r));

/** 三类行渲染行（取段样式用） */
const actRows = (rows: HistoryRow[], width = W) =>
  buildContentRows(rows, {}, width, width).activity;

/** 名字 / 参数 / 结果三类行的便捷构造 */
const name = (text: string, ok?: boolean): HistoryRow => ({
  text,
  kind: "tool",
  toolRole: "name",
  ...(ok === undefined ? {} : { toolOk: ok }),
});
const param = (n: string, value: string): HistoryRow => ({
  text: value,
  kind: "tool",
  toolRole: "param",
  toolParam: { name: n, value },
});
const result = (text: string, ok: boolean): HistoryRow => ({
  text,
  kind: "tool",
  toolRole: "result",
  toolOk: ok,
});

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
    .map((text) => text.replace(/^┃+/, ""))
    .filter((text) => !text.startsWith("╌╌"));

/** 去掉 turn / step 的交付类型（分布式 Omit：保留联合各分支的判别字段） */
type NoScope<T> = T extends unknown ? Omit<T, "turn" | "step"> : never;

/** 一步脚本：step 声明 + 若干工具交付 */
const step = (...deliveries: NoScope<BlockDelivery>[]): BlockDelivery[] => [
  { kind: "step-start", turn: 1, step: 1, time: T0 },
  ...deliveries.map((d) => ({ ...d, turn: 1, step: 1 }) as BlockDelivery),
];

test("完成态：名字行 `✓ 工具名` + 参数行缩进 4 + 结果行缩进 2", () => {
  const out = act([
    name("read", true),
    param("path", "TUI/src/app/layout.ts"),
    result("2311 行", true),
  ]);
  assert.deepEqual(out, [
    "✓ read",
    "    path TUI/src/app/layout.ts",
    "  2311 行",
  ]);
});

test("在飞态：名字行 `●`（无结果）；静默工具（空结果）不挂结果行", () => {
  assert.deepEqual(act([name("bash"), param("command", "npm test")]), [
    "● bash",
    "    command npm test",
  ]);
});

test("失败态：名字行 `✗` 红 + 结果行整行红；参数行不染", () => {
  const rows = actRows([
    name("bash", false),
    param("command", "npm run test:tui"),
    result("1 test failed: grid.test.ts", false),
  ]);
  const texts = rows.map(rowText);
  assert.deepEqual(texts, [
    "✗ bash",
    "    command npm run test:tui",
    "  1 test failed: grid.test.ts",
  ]);
  const [nameRow, paramRow, resultRow] = rows;
  assert.equal(nameRow!.segments[0]!.style?.fg, "red", "✗ 红");
  assert.equal(nameRow!.segments[2]!.style?.fg, "yellow", "工具名保持黄");
  assert.ok(
    paramRow!.segments.every((s) => s.style?.fg !== "red"),
    "参数行不染红",
  );
  assert.ok(
    resultRow!.segments.every((s) => s.style?.fg === "red"),
    "失败结果整行红",
  );
});

test("参数值折行上限 5 行：超出 → 前 2 + `…` + 后 2（续行悬挂 6）", () => {
  const value = ["一", "二", "三", "四", "五", "六"].join("\n");
  const out = act([name("bash", true), param("", value)]);
  assert.deepEqual(out, [
    "✓ bash",
    "    一",
    "      二",
    "      …",
    "      五",
    "      六",
  ]);
  // 无名兜底之外的悬挂：带参数名时续行 6 列
  const long = "x".repeat(60);
  const out2 = act([name("bash", true), param("command", long)], 30);
  const cont = out2.slice(2);
  assert.ok(cont.length > 0, "超宽参数应折行: " + JSON.stringify(out2));
  for (const line of cont) {
    assert.ok(
      line.startsWith("      "),
      `续行悬挂 6 列：${JSON.stringify(line)}`,
    );
    assert.ok(
      displayWidth(line) <= 30,
      `折行不超窗宽：${JSON.stringify(line)}`,
    );
  }
});

test("参数名超宽：自身截断加 `…`，且不超窗宽", () => {
  const out = act([name("bash", true), param("n".repeat(60), "v")]);
  const paramLine = out[1]!;
  assert.ok(
    paramLine.endsWith("…") || out.length > 2,
    "名字被截断或值另起一行",
  );
  assert.ok(
    out.every((line) => displayWidth(line) <= W),
    `每行不超窗宽：${JSON.stringify(out)}`,
  );
});

test("名字行超宽：截到占满一行 + `…` 收尾（不折行）", () => {
  const out = act([name("x".repeat(80), true)]);
  assert.equal(out.length, 1, "名字行不折行");
  assert.ok(out[0]!.endsWith("…"), "截断收尾: " + out[0]);
  assert.ok(displayWidth(out[0]!) <= W, "不超过窗宽");
});

test("长名取舍：另起总行数 ≤ 同行 → 值另起一行（缩进 6）", () => {
  const longName = "n".repeat(34);
  const out = act([name("bash", true), param(longName, "abcde")]);
  assert.deepEqual(out, ["✓ bash", "    " + longName, "      abcde"]);
});

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

test("非 JSON 参数渲染：无名兜底（值 = 原文，缩进 4）", () => {
  assert.deepEqual(act([name("bash", true), param("", "ls -la")]), [
    "✓ bash",
    "    ls -la",
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
  assert.deepEqual(out, [
    "✓ read",
    "    path p1",
    "✗ grep",
    "    pattern p2",
    "  no match",
    "  ok1",
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
  assert.deepEqual(out, ["✓ read", "    a", "✗ grep", "    b", "  r1", "  r2"]);
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
