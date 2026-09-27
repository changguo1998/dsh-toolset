// tests/steer-queued-display.test.ts — steer 排队显示（BACKLOG TUI#43）
//
// 覆盖：排队项带类型（followup / steer）；忙时 `<` 提交进排队块（独立成行、不写 buffer）、
// 空闲时直达回显；渲染顺序 steer 在 followup 之上；右缘竖线 steer 黄 / followup 灰 /
// 已发出亮红；核心在 step 边界认领（inbox-claim）后 steer 项转入历史流。

import { test } from "node:test";
import assert from "node:assert/strict";

import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { AppState } from "../src/app/state.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import { THEMES, ansiNameToHex, hexSgr } from "../src/renderer/theme.ts";

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

/** 逐字符输入（不提交） */
function type(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) renderer.press(key(ch));
}

/** 输入并提交 */
function typeAndEnter(renderer: FakeRenderer, text: string): void {
  type(renderer, text);
  renderer.press(key("enter"));
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeApp(): {
  renderer: FakeRenderer;
  adapter: FakeAdapter;
  st: () => AppState;
  app: App;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  return {
    renderer,
    adapter,
    app,
    st: () => (app as unknown as { state: AppState }).state,
  };
}

/** dark 主题下颜色名的 truecolor 前景 SGR 序列 */
const sgrOf = (name: "yellow" | "gray" | "brightRed"): string =>
  hexSgr(ansiNameToHex(THEMES.dark, name) ?? "", true);

/** 帧内包含指定文本的行（原始行，含 ANSI） */
function rawRowOf(renderer: FakeRenderer, text: string): string {
  const row = renderer.lastRender.find((l) => l.includes(text));
  assert.ok(row !== undefined, `帧内应有含「${text}」的行`);
  return row;
}

test("reducer：排队项带类型；认领按类型各取最早一条（互不误吃）", () => {
  let s: AppState = initialState();
  s = reduceState(s, { type: "queued-push", text: "普通一" });
  s = reduceState(s, { type: "queued-push", text: "steer 一", kind: "steer" });
  s = reduceState(s, { type: "queued-push", text: "普通二" });
  assert.deepEqual(
    s.queued,
    [
      { text: "普通一", kind: "followup" },
      { text: "steer 一", kind: "steer" },
      { text: "普通二", kind: "followup" },
    ],
    "数组按提交顺序存；kind 缺省 followup",
  );

  // 回合开始：认领最早 **followup**（不误吃 steer）
  const claimedFollow = reduceState(s, { type: "queued-claim" });
  assert.deepEqual(
    claimedFollow.queued.map((q) => q.text),
    ["steer 一", "普通二"],
  );
  assert.ok(
    claimedFollow.buffer.some((l) => l.kind === "user" && l.text === "普通一"),
    "被认领的 followup 转入历史流",
  );

  // step 边界：认领最早 **steer**（不误吃 followup）
  const claimedSteer = reduceState(s, { type: "queued-claim-steer" });
  assert.deepEqual(
    claimedSteer.queued.map((q) => q.text),
    ["普通一", "普通二"],
  );
  assert.ok(
    claimedSteer.buffer.some((l) => l.kind === "user" && l.text === "steer 一"),
    "被认领的 steer 转入历史流",
  );

  // 队列里没有该类条目 → no-op（不误吃别的类型）
  assert.equal(
    reduceState(claimedSteer, { type: "queued-claim-steer" }),
    claimedSteer,
  );
});

test("忙时 `<` 提交：进排队块（不写 buffer）、steer 排在 followup 之上、右缘竖线黄 vs 灰", () => {
  const { renderer, adapter, st, app } = makeApp();
  typeAndEnter(renderer, "先发一条"); // 使 App 进入 running（本地过渡态）
  typeAndEnter(renderer, "普通排队"); // followup 排队
  assert.deepEqual(adapter.steered, [], "此时还没有 steer");
  renderer.press(key("<"));
  typeAndEnter(renderer, "steer 排队");
  try {
    assert.deepEqual(
      st().queued,
      [
        { text: "普通排队", kind: "followup" },
        { text: "steer 排队", kind: "steer" },
      ],
      "两条都进排队（数组按提交顺序）",
    );
    assert.deepEqual(adapter.steered, ["steer 排队"], "投递目标 next-step");
    assert.ok(
      !st().buffer.some((l) => l.text === "steer 排队"),
      "排队中不写历史 buffer（独立成行由排队块渲染）",
    );

    const steerRow = rawRowOf(renderer, "steer 排队");
    const followRow = rawRowOf(renderer, "普通排队");
    assert.ok(
      renderer.lastRender.indexOf(steerRow) <
        renderer.lastRender.indexOf(followRow),
      "steer 排在 followup 之上",
    );
    assert.ok(
      steerRow.includes(sgrOf("yellow") + "┃"),
      "steer 排队右缘竖线为黄: " + JSON.stringify(steerRow.slice(-60)),
    );
    assert.ok(
      followRow.includes(sgrOf("gray") + "┃"),
      "followup 排队右缘竖线仍为灰: " + JSON.stringify(followRow.slice(-60)),
    );
    assert.ok(
      !steerRow.includes(sgrOf("gray") + "┃"),
      "steer 行不应出现灰竖线",
    );
  } finally {
    app.dispose();
  }
});

test("核心在 step 边界认领（inbox-claim / next-step）→ 该条转入历史流，排队块只剩 followup", async () => {
  const { renderer, adapter, st, app } = makeApp();
  typeAndEnter(renderer, "先发一条");
  typeAndEnter(renderer, "普通排队");
  renderer.press(key("<"));
  typeAndEnter(renderer, "steer 排队");
  try {
    adapter.push({ type: "inbox-claim", target: "next-step" });
    await tick();
    assert.deepEqual(
      st().queued.map((q) => q.text),
      ["普通排队"],
      "只认领 steer，followup 仍排队",
    );
    assert.ok(
      st().buffer.some((l) => l.kind === "user" && l.text === "steer 排队"),
      "认领后成为历史用户行",
    );
    assert.ok(
      !st().buffer.some((l) => l.text === "普通排队"),
      "followup 未被误认领",
    );
  } finally {
    app.dispose();
  }
});

test("空闲时 `<` 提交：直达回显（不留排队闪影），投递仍为 next-step", () => {
  const { renderer, adapter, st, app } = makeApp();
  try {
    renderer.press(key("<"));
    typeAndEnter(renderer, "空闲 steer");
    assert.deepEqual(st().queued, [], "空闲无需排队");
    assert.deepEqual(adapter.steered, ["空闲 steer"]);
    assert.ok(
      st().buffer.some((l) => l.kind === "user" && l.text === "空闲 steer"),
      "立即回显为用户块",
    );
    // 回显的用户块右缘竖线是「已发出」的亮红
    const row = rawRowOf(renderer, "空闲 steer");
    assert.ok(
      row.includes(sgrOf("brightRed") + "┃"),
      "已发出用户块右缘竖线亮红: " + JSON.stringify(row.slice(-60)),
    );
  } finally {
    app.dispose();
  }
});

test("宿主无 steer + 忙：降级为 followup 排队（灰线）并给提示，消息不丢", () => {
  const { renderer, adapter, st, app } = makeApp();
  adapter.steerSupported = false;
  try {
    typeAndEnter(renderer, "先发一条");
    renderer.press(key("<"));
    typeAndEnter(renderer, "降级 steer");
    assert.deepEqual(st().queued, [{ text: "降级 steer", kind: "followup" }]);
    assert.deepEqual(adapter.sent.includes("降级 steer"), true, "消息仍发出");
    assert.deepEqual(adapter.steered, [], "未走 steer 投递");
    assert.ok(
      st().buffer.some(
        (l) => l.kind === "notice" && l.text.includes("宿主不支持 steer"),
      ),
      "降级提示落 buffer: " + JSON.stringify(st().buffer),
    );
    const row = rawRowOf(renderer, "降级 steer");
    assert.ok(row.includes(sgrOf("gray") + "┃"), "降级后按 followup 灰线渲染");
  } finally {
    app.dispose();
  }
});
