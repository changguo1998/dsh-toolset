// tests/activity-level.test.ts —— 活动区显示开关（SPEC §6.8；/verbose [think|tool|reply] on|off）
//
// 三项全开（缺省）：思考 / 正文 / 工具块都显示；关某项即隐藏该类内容。
// notice 与 step 分隔头恒显，不归三类。

import { test } from "node:test";
import assert from "node:assert/strict";

import { App } from "../src/app/index.ts";
import { rowText } from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import type { HistoryRow } from "../src/app/state.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";

const W = 80;
const L = (text: string, kind: HistoryRow["kind"]): HistoryRow => ({
  text,
  kind,
});

/** 活动区渲染文本行（show 缺省 = 三项全开） */
const act = (
  buf: HistoryRow[],
  show?: { think?: boolean; tool?: boolean; reply?: boolean },
): string[] =>
  buildContentRows(
    buf,
    show === undefined ? {} : { activityShow: show },
    W,
    W,
  ).activity.map(rowText);

const MIXED: HistoryRow[] = [
  L("思考一段", "thinking"),
  L("正文一段", "assistant"),
  L("22:31:05 #1", "tool"),
  L("○ bash ls", "tool"),
  L("✓ ok", "tool"),
  L("提示行", "notice"),
];

test("缺省（三项全开）：思考 / 正文 / 工具块 / notice 全显示", () => {
  const joined = act(MIXED).join("\n");
  for (const t of ["思考一段", "正文一段", "○ bash ls", "✓ ok", "提示行"])
    assert.ok(joined.includes(t), `缺省应含「${t}」：${joined}`);
});

test("显示开关 think off：只隐藏思考行", () => {
  const joined = act(MIXED, { think: false }).join("\n");
  assert.ok(!joined.includes("思考一段"), "思考行隐藏");
  for (const t of ["正文一段", "○ bash ls", "✓ ok", "提示行"])
    assert.ok(joined.includes(t), `think off 仍应含「${t}」：${joined}`);
});

test("显示开关 tool off：隐藏工具块，step 分隔头恒显", () => {
  const joined = act(MIXED, { tool: false }).join("\n");
  assert.ok(!joined.includes("○ bash ls"), "工具名字行隐藏");
  assert.ok(!joined.includes("✓ ok"), "工具结果行隐藏");
  assert.ok(joined.includes("22:31:05 #1"), "step 分隔头恒显");
  for (const t of ["思考一段", "正文一段", "提示行"])
    assert.ok(joined.includes(t), `tool off 仍应含「${t}」：${joined}`);
});

test("显示开关 reply off：隐藏活动区非 final 正文，final 正文与 notice 不受影响", () => {
  const buf: HistoryRow[] = [
    L("中间正文", "assistant"),
    { ...L("最终正文", "assistant"), final: true },
    L("提示行", "notice"),
  ];
  const joined = act(buf, { reply: false }).join("\n");
  assert.ok(!joined.includes("中间正文"), "非 final 正文隐藏");
  assert.ok(joined.includes("提示行"), "notice 恒显");
});

// —— 命令面：/verbose [think|tool|reply] [on|off] ——

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super({ ...deps, pipelineSink: deps.pipelineSink ?? {} });
    registerApp(this);
  }
}

const key = (name: string): KeyEvent => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
});

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) renderer.press(key(ch));
  renderer.press(key("enter"));
}

test("命令面：/verbose 按类别切换显示，非法参数不改状态", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  const show = (): { think: boolean; tool: boolean; reply: boolean } =>
    (app as unknown as { state: { activityShow: never } }).state.activityShow;
  try {
    assert.deepEqual(show(), { think: true, tool: true, reply: true });
    typeAndEnter(renderer, "/verbose think off");
    assert.equal(show().think, false);
    assert.equal(show().tool, true, "只改指定类别");
    assert.ok(renderer.lastRender.join("\n").includes("think → off"));
    typeAndEnter(renderer, "/verbose tool off");
    assert.equal(show().tool, false);
    typeAndEnter(renderer, "/verbose reply on");
    assert.equal(show().reply, true, "缺省已是 on，重复设置不报错");
    typeAndEnter(renderer, "/verbose all off");
    assert.deepEqual(show(), { think: false, tool: false, reply: false });
    typeAndEnter(renderer, "/verbose all on");
    assert.deepEqual(show(), { think: true, tool: true, reply: true });
    typeAndEnter(renderer, "/verbose think maybe");
    assert.deepEqual(
      show(),
      { think: true, tool: true, reply: true },
      "非法取值不改状态",
    );
    assert.ok(renderer.lastRender.join("\n").includes("usage: /verbose"));
    typeAndEnter(renderer, "/verbose");
    assert.ok(renderer.lastRender.join("\n").includes("usage: /verbose"));
  } finally {
    app.dispose();
  }
});
