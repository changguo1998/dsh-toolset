// tests/activity-level.test.ts — 活动区输出内容档位（BACKLOG #8：/verbose think|tool|step）
//   think（缺省）= 思考 + 正文 + 工具调用（全量）；tool = 正文 + 工具调用（去思考）；
//   step = 正文 + 工具调用的**调用行**（step 头与 notice 保留，结果行 / 辅助行去掉）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { App } from "../src/app/index.ts";
import { rowText } from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import type { Buffer, BufferLine } from "../src/app/state.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";

const W = 80;
const L = (text: string, kind: BufferLine["kind"]): BufferLine => ({
  text,
  kind,
});

/** 活动区渲染文本行（level 缺省 = think） */
const act = (buf: Buffer, level?: "think" | "tool" | "step"): string[] =>
  buildContentRows(
    buf,
    {
      themeId: "dark",
      ...(level === undefined ? {} : { activityLevel: level }),
    },
    W,
    W,
  ).activity.map(rowText);

const MIXED: Buffer = [
  L("思考一段", "thinking"),
  L("正文一段", "assistant"),
  L("22:31:05 #1", "tool"),
  L("○ bash ls", "tool"),
  L("✓ ok", "tool"),
  L("提示行", "notice"),
];

test("#8 think（缺省）：思考 / 正文 / 工具 / notice 全显示", () => {
  const joined = act(MIXED).join("\n");
  for (const t of ["思考一段", "正文一段", "○ bash ls", "✓ ok", "提示行"])
    assert.ok(joined.includes(t), `think 档应含「${t}」：${joined}`);
});

test("#8 tool：去思考行，正文 / 工具调用 / 结果 / notice 保留", () => {
  const joined = act(MIXED, "tool").join("\n");
  assert.ok(!joined.includes("思考一段"), "思考被过滤");
  for (const t of ["正文一段", "○ bash ls", "✓ ok", "提示行"])
    assert.ok(joined.includes(t), `tool 档应含「${t}」：${joined}`);
});

test("#8 step：只留工具调用行（step 头与 notice 保留；结果行去掉）", () => {
  const joined = act(MIXED, "step").join("\n");
  assert.ok(!joined.includes("思考一段"), "思考被过滤");
  assert.ok(!joined.includes("✓ ok"), "结果行去掉");
  for (const t of ["正文一段", "22:31:05 #1", "○ bash ls", "提示行"])
    assert.ok(joined.includes(t), `step 档应含「${t}」：${joined}`);
});

test("#8 step：调用行只取首个物理行（去参数续行），结果行整条去掉", () => {
  const buf: Buffer = [
    L("bash run cmd\n  参数甲", "tool"),
    L("✓ done", "tool"),
  ];
  const rows = act(buf, "step")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  assert.equal(rows.length, 1, `只剩调用行首行：${JSON.stringify(rows)}`);
  assert.ok(rows[0]!.includes("bash run cmd"), "留下的是调用行首行");
  assert.ok(!rows[0]!.includes("参数甲"), "参数续行不显示");
});

// —— 命令面：/verbose think|tool|step ——

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
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

test("#8 命令：/verbose think|tool|step 切换档位；无参 / 非法参数只提示用法不动状态", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  const level = (): string =>
    (app as unknown as { state: { activityVerbose: string } }).state
      .activityVerbose;
  try {
    assert.equal(level(), "think", "缺省 think");
    typeAndEnter(renderer, "/verbose tool");
    assert.equal(level(), "tool", "切到 tool");
    assert.ok(
      renderer.lastRender.join("\n").includes("活动区内容：tool"),
      "切换有 notice 回执",
    );
    typeAndEnter(renderer, "/verbose step");
    assert.equal(level(), "step", "切到 step");
    typeAndEnter(renderer, "/verbose");
    assert.equal(level(), "step", "无参不切换");
    assert.ok(
      renderer.lastRender
        .join("\n")
        .includes("usage: /verbose think|tool|step"),
      "无参给用法提示",
    );
    typeAndEnter(renderer, "/verbose 也许");
    assert.equal(level(), "step", "非法参数不切换");
    typeAndEnter(renderer, "/verbose think");
    assert.equal(level(), "think", "切回 think");
  } finally {
    app.dispose();
  }
});

test("#8 命令：档位与 /collapse（紧凑）正交——互不覆盖", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  const st = (): { activityCompact: boolean; activityVerbose: string } =>
    (app as unknown as { state: never }).state;
  try {
    typeAndEnter(renderer, "/verbose tool");
    typeAndEnter(renderer, "/collapse on");
    assert.equal(st().activityVerbose, "tool", "紧凑不改内容档位");
    assert.equal(st().activityCompact, true, "紧凑开关独立");
    typeAndEnter(renderer, "/verbose step");
    assert.equal(st().activityCompact, true, "/verbose 不改紧凑开关");
    assert.equal(st().activityVerbose, "step");
  } finally {
    app.dispose();
  }
});
