// tests/steer-queued-display.test.ts — steer 排队显示（BACKLOG TUI#43）
//
// 覆盖：排队项带类型（followup / steer）；忙时提交进排队块（独立成行、不写 buffer）、
// 空闲时直达回显；渲染顺序 steer 在 followup 之上；右缘竖线 steer 黄 / followup 灰 /
// 已发出亮红；核心在 step 边界认领（inbox-claim）后 steer 项转入历史流。
// 2026-10-13 模式交换后：**默认模式 = steer**（直接提交即插话），`<` = followup（排队等下一回合）。
//
// 条目 16 段 C2：内容不再有缓冲行形态——「被 steer 续接」标与 steer 留白都改在**节缓存 /
// pane** 上断言（交付驱动；标记由流水线产出，见 `pipeline/sections.ts` 的 `user-flag` 与
// 带 `queued:"steer"` 的用户交付）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { App } from "../src/app/index.ts";
import { withDelivery, withUser } from "./helpers/pipelineContent.ts";
import {
  allSections,
  applyDelivery,
  createSections,
} from "../src/app/layout/pipeline/sections.ts";
import { splitSections } from "../src/app/layout/pipeline/split.ts";
import { parse } from "../src/app/layout/pipeline/parse.ts";
import { route } from "../src/app/layout/pipeline/route.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { AppState } from "../src/app/state.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import { THEMES, ansiNameToHex, hexSgr } from "../src/renderer/theme.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    const sink = deps.pipelineSink ?? {};
    super({ ...deps, pipelineSink: sink });
    (deps.adapter as unknown as { mirrorTo?: typeof sink }).mirrorTo = sink;
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
const sgrOf = (
  name: "yellow" | "brightYellow" | "gray" | "brightRed",
): string => hexSgr(ansiNameToHex(THEMES.dark, name) ?? "", true);

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
  // 条目 16 段 C2：内容不再有缓冲行形态——「认领即转入历史流」改由 App 认领时随交付发出
  // （`index.ts` 的 `queued-claim` 分支 → 节缓存），本用例只钉队列事实。等价覆盖：
  // `tests/app.test.ts`「agent 运行中 Enter → 官方流程」断言被认领的 followup 成为节缓存
  // 里的用户块；steer 认领的节缓存断言见下方「核心在 step 边界认领」用例。

  // step 边界：认领最早 **steer**（不误吃 followup）
  const claimedSteer = reduceState(s, { type: "queued-claim-steer" });
  assert.deepEqual(
    claimedSteer.queued.map((q) => q.text),
    ["普通一", "普通二"],
  );

  // 队列里没有该类条目 → no-op（不误吃别的类型）
  assert.equal(
    reduceState(claimedSteer, { type: "queued-claim-steer" }),
    claimedSteer,
  );
});

test("step 边界认领整批 steer：全部出队（宿主一次摘走整批 next-step）", () => {
  let s = initialState();
  s = reduceState(s, { type: "queued-push", text: "排队一", kind: "steer" });
  s = reduceState(s, { type: "queued-push", text: "普通", kind: "followup" });
  s = reduceState(s, { type: "queued-push", text: "排队二", kind: "steer" });
  const claimed = reduceState(s, { type: "queued-claim-steer" });
  assert.deepEqual(
    claimed.queued.map((q) => q.text),
    ["普通"],
    "全部 steer 出队，followup 不受影响",
  );
  // 没有 steer 可认领 → no-op（不误吃别的类型）
  assert.equal(reduceState(claimed, { type: "queued-claim-steer" }), claimed);
});

test("step 边界认领整批 steer：合成一个用户块，多条原文只换行不加空行", async () => {
  const { renderer, adapter, st, app } = makeApp();
  typeAndEnter(renderer, "先发一条");
  typeAndEnter(renderer, "插话一");
  typeAndEnter(renderer, "插话二");
  try {
    assert.equal(st().queued.length, 2, "两条 steer 各自排队");
    adapter.push({ type: "inbox-claim", target: "next-step" });
    await tick();
    assert.deepEqual(st().queued, [], "一次认领清空全部 steer");
    const dumped = JSON.stringify(
      ((app as unknown as { sections: unknown }).sections ?? []) as unknown,
    );
    assert.ok(
      dumped.includes("插话一\\n插话二"),
      "节缓存里合成一个用户块，原文只换行连接",
    );
  } finally {
    app.dispose();
  }
});

test("忙时提交：进排队块（不写 buffer）、steer 排在 followup 之上、右缘竖线浅黄 vs 灰", () => {
  const { renderer, adapter, st, app } = makeApp();
  typeAndEnter(renderer, "先发一条"); // 默认模式=steer；空闲 → 直发并进入 running
  renderer.press(key("<"));
  typeAndEnter(renderer, "普通排队"); // followup 排队（`<` 模式）
  assert.deepEqual(adapter.steered, ["先发一条"], "空闲那条已按 steer 投递");
  typeAndEnter(renderer, "steer 排队"); // 默认模式（已回退）→ steer 排队
  try {
    assert.deepEqual(
      st().queued,
      [
        { text: "普通排队", kind: "followup" },
        { text: "steer 排队", kind: "steer" },
      ],
      "两条都进排队（数组按提交顺序）",
    );
    assert.deepEqual(
      adapter.steered,
      ["先发一条", "steer 排队"],
      "默认模式两条都走 next-step",
    );
    assert.ok(
      !st().local.some((l) => l.text === "steer 排队"),
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
      steerRow.includes(sgrOf("brightYellow") + "┃"),
      "steer 排队右缘竖线为浅黄: " + JSON.stringify(steerRow.slice(-60)),
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
  renderer.press(key("<"));
  typeAndEnter(renderer, "普通排队");
  typeAndEnter(renderer, "steer 排队");
  try {
    adapter.push({ type: "inbox-claim", target: "next-step" });
    await tick();
    assert.deepEqual(
      st().queued.map((q) => q.text),
      ["普通排队"],
      "只认领 steer，followup 仍排队",
    );
    // 条目 16 段 C1：用户块不再写缓冲 → 改断言节缓存里有该用户块（形状无关的序列化查找）
    assert.ok(
      JSON.stringify(
        (app as unknown as { sections: unknown }).sections ?? [],
      ).includes("steer 排队"),
      "认领后成为历史用户行（节缓存）",
    );
    assert.ok(
      !st().local.some((l) => l.text === "普通排队"),
      "followup 未被误认领",
    );
  } finally {
    app.dispose();
  }
});

test("#4 节缓存：steer 认领给上一条用户块打「被续接」标 + steer 块留白；followup/首条不标", () => {
  // 条目 16 段 C2：两个标记不再长在缓冲行上——steer 认领时 App 发两条交付（`index.ts` 的
  // `inbox-claim` 分支）：`user-flag` 给**上一条**用户块打「被续接」标（渲染永久 `←`），
  // 带 `queued:"steer"` 的用户块所在节带 steer 标 → pane 层在其上方插留白。
  const userItems = (
    s: AppState,
  ): { text?: string; steerContinued?: boolean }[] =>
    allSections(s.pipeline!)
      .flatMap((section) => section.items)
      .filter((item) => item.source === "user");
  /** 会话区 pane 项类型序列（`gap` = 留白；新链 §1-§3 由 split / parse / route 产出） */
  const paneKinds = (s: AppState): string[] => {
    const groups = splitSections(s.pipeline!).map((section) => ({
      provenance: section,
      blocks: parse(section),
      ...(section.calls === undefined ? {} : { calls: section.calls }),
      ...(section.results === undefined ? {} : { results: section.results }),
    }));
    return route(groups, { activityShow: { think: true } }).session.map(
      (item) => item.kind,
    );
  };

  // steer 认领：上一条输入 steerContinued + 认领块上方留白
  let s = withUser(initialState(), "第一条");
  s = withDelivery(s, { kind: "user-flag", steerContinued: true });
  s = withDelivery(s, {
    kind: "user",
    turn: 1,
    step: 1,
    text: "steer 插队",
    queued: "steer",
  });
  assert.deepEqual(
    userItems(s).map((item) => [item.text, item.steerContinued ?? false]),
    [
      ["第一条", true],
      ["steer 插队", false],
    ],
    "上一条输入标「被 steer 续接」，认领块自身不标",
  );
  assert.deepEqual(
    paneKinds(s),
    ["paragraph", "gap", "paragraph"],
    "steer 块与上一条输入之间留白",
  );

  // followup 认领：两个标记都不落
  let f = withUser(initialState(), "第一条");
  f = withDelivery(f, { kind: "user", turn: 1, step: 1, text: "普通排队" });
  assert.ok(
    userItems(f).every((item) => item.steerContinued !== true),
    "followup 认领不加「被续接」标",
  );
  assert.deepEqual(
    paneKinds(f),
    ["paragraph", "paragraph"],
    "followup 认领不留白",
  );

  // 会话首条即 steer：无参照物 → 不标不留白
  const empty = createSections();
  assert.equal(
    applyDelivery(empty, { kind: "user-flag", steerContinued: true }),
    empty,
    "无上一条用户块 → `user-flag` 空转（不标符号）",
  );
  const first = withDelivery(initialState(), {
    kind: "user",
    turn: 1,
    step: 1,
    text: "首条 steer",
    queued: "steer",
  });
  assert.ok(
    userItems(first).every((item) => item.steerContinued !== true),
    "首条 steer 无参照物 → 不标符号",
  );
  assert.deepEqual(
    paneKinds(first),
    ["paragraph"],
    "首条 steer 前无内容 → 不留白",
  );
});

test("#4 渲染：被 steer 续接的用户块显示 ←，steer 块与上一条输入之间留空行", async () => {
  const { renderer, adapter, app } = makeApp();
  typeAndEnter(renderer, "先发一条");
  typeAndEnter(renderer, "steer 排队"); // 默认模式：忙时插话排队
  adapter.push({ type: "inbox-claim", target: "next-step" });
  await tick();
  try {
    const row = rawRowOf(renderer, "先发一条");
    assert.ok(
      row.includes("←"),
      "上一条输入的状态符号为 ←: " + JSON.stringify(row),
    );
    const prevIdx = renderer.lastRender.findIndex((l) =>
      l.includes("先发一条"),
    );
    const idx = renderer.lastRender.findIndex((l) => l.includes("steer 排队"));
    assert.ok(
      idx > prevIdx + 1,
      `steer 块与上一条输入之间应留一个空行（行距 ${idx - prevIdx}）`,
    );
  } finally {
    app.dispose();
  }
});

test("空闲时默认（steer）提交：直达回显（不留排队闪影），投递为 next-step", () => {
  const { renderer, adapter, st, app } = makeApp();
  try {
    typeAndEnter(renderer, "空闲 steer");
    assert.deepEqual(st().queued, [], "空闲无需排队");
    assert.deepEqual(adapter.steered, ["空闲 steer"]);
    // 条目 16 段 C1：用户块不再写缓冲 → 改断言节缓存里有该用户块
    assert.ok(
      JSON.stringify(
        (app as unknown as { sections: unknown }).sections ?? [],
      ).includes("空闲 steer"),
      "立即回显为用户块（节缓存）",
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
    typeAndEnter(renderer, "降级 steer"); // 默认 steer 路径 + 宿主不支持 → 降级 followup 排队
    assert.deepEqual(st().queued, [{ text: "降级 steer", kind: "followup" }]);
    assert.deepEqual(adapter.sent.includes("降级 steer"), true, "消息仍发出");
    assert.deepEqual(adapter.steered, [], "未走 steer 投递");
    assert.ok(
      st().local.some(
        (l) => l.kind === "notice" && l.text.includes("宿主不支持 steer"),
      ),
      "降级提示落 buffer: " + JSON.stringify(st().local),
    );
    const row = rawRowOf(renderer, "降级 steer");
    assert.ok(row.includes(sgrOf("gray") + "┃"), "降级后按 followup 灰线渲染");
  } finally {
    app.dispose();
  }
});
