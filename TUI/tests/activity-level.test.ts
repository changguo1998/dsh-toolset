// tests/activity-level.test.ts — 活动区输出内容档位（BACKLOG #8：/verbose think|tool|step）
//   think（缺省）= 思考 + 正文 + 工具调用（全量）；tool = 正文 + 工具调用（去思考）；
//   step = 正文 + 工具调用的**调用行**（step 头与 notice 保留，结果行 / 辅助行去掉）。

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

/** 活动区渲染文本行（level 缺省 = think） */
const act = (buf: HistoryRow[], level?: "think" | "tool" | "step"): string[] =>
  buildContentRows(
    buf,
    {
      ...(level === undefined ? {} : { activityLevel: level }),
    },
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

test("#8 step：工具块恒完整形态（2026-10-13 决策 6：档位对工具块失效）", () => {
  const joined = act(MIXED, "step").join("\n");
  assert.ok(!joined.includes("思考一段"), "思考行仍被档位过滤（该分支未退休）");
  for (const t of ["正文一段", "22:31:05 #1", "○ bash ls", "✓ ok", "提示行"])
    assert.ok(
      joined.includes(t),
      `step 档下工具块应完整：缺「${t}」：${joined}`,
    );
});

test("#8 step：调用行不再截断（参数续行与结果行都保留）", () => {
  const buf: HistoryRow[] = [
    L("bash run cmd\n  参数甲", "tool"),
    L("✓ done", "tool"),
  ];
  const joined = act(buf, "step")
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .join("\n");
  assert.ok(joined.includes("bash run cmd"), `调用行保留：${joined}`);
  assert.ok(joined.includes("参数甲"), `参数续行不再被截掉：${joined}`);
  assert.ok(joined.includes("✓ done"), `结果行不再被去掉：${joined}`);
});

// —— 命令面：/verbose think|tool|step ——

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

test("#8 命令：/verbose 已下线（2026-10-13 决策 8 第 11 条）——提示且不改状态", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  const level = (): string =>
    (app as unknown as { state: { activityVerbose: string } }).state
      .activityVerbose;
  try {
    assert.equal(level(), "think", "缺省 think");
    for (const line of [
      "/verbose tool",
      "/verbose step",
      "/verbose",
      "/verbose 也许",
    ]) {
      typeAndEnter(renderer, line);
      assert.equal(level(), "think", `${line} 不改状态`);
      assert.ok(
        renderer.lastRender.join("\n").includes("该命令已下线（待重新设计）"),
        `${line} 给统一下线提示`,
      );
    }
  } finally {
    app.dispose();
  }
});

test("#8 命令：/collapse 与 /verbose 均已下线——两个开关都不再被命令改动", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  const st = (): { activityCompact: boolean; activityVerbose: string } =>
    (app as unknown as { state: never }).state;
  try {
    typeAndEnter(renderer, "/collapse on");
    assert.equal(st().activityCompact, false, "/collapse 不改紧凑开关");
    typeAndEnter(renderer, "/verbose tool");
    assert.equal(st().activityVerbose, "think", "/verbose 不改内容档位");
    assert.ok(
      renderer.lastRender.join("\n").includes("该命令已下线（待重新设计）"),
      "两条命令都给下线提示",
    );
  } finally {
    app.dispose();
  }
});
