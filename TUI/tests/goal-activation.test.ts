// tests/goal-activation.test.ts — goal 自动续轮开关（activation）状态单测
//
// 覆盖：reduceState 的 `goal-activation`（armed / disarmed 边覆盖、无 `activation` = 清记录、
// 按 sessionId 隔离、不落 tui-state.json）、selector `activeGoalActivation` 的门控与推导——
// 无 goal / 非 active 相位 → 不显示（undefined）；active 且**无记录** → `disarmed`
// （宿主重启后 setActivation(disarmed) 与初值相同、不发事件，靠该推导兜底）；收到过边则取末条。
// 渲染面（⟳ 符号与颜色）见 tests/status-column.test.ts；事件归一化见 tests/adapter.dsh.test.ts。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activeGoalActivation,
  initialState,
  reduceState,
} from "../src/app/state.ts";
import type { AppState } from "../src/app/state.ts";
import { App } from "../src/app/index.ts";
import { THEMES, ansiNameToHex, hexSgr } from "../src/renderer/theme.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";

const SID = "s1";

/** 名 → truecolor 前景 SGR（dark 主题） */
const sgrOf = (name: "green" | "gray"): string =>
  hexSgr(ansiNameToHex(THEMES.dark, name) ?? "", true);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

/** 建立「s1 有当前 goal（相位可指定）」的状态（模拟宿主 `goal/change` 回放/事件） */
function withGoal(phase: "active" | "paused" | "complete"): AppState {
  return reduceState(initialState(), {
    type: "goal-change",
    sessionId: SID,
    operation: "create",
    goal: { id: "g1", revision: 1, objective: "目标", phase },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1,
  });
}

/** 追加一条 activation 边（`activation` 缺省 = 宿主该会话已无当前 goal → 清记录） */
function edge(state: AppState, activation?: "armed" | "disarmed"): AppState {
  return reduceState(state, {
    type: "goal-activation",
    sessionId: SID,
    ...(activation === undefined ? {} : { activation }),
  });
}

test("goal-activation reducer: armed / disarmed 边覆盖（取末条），按 sessionId 隔离", () => {
  let s = withGoal("active");
  assert.deepEqual(s.goalActivationBySession, {}, "初始无记录");
  s = edge(s, "armed");
  assert.equal(s.goalActivationBySession[SID], "armed", "armed 边落记录");
  s = edge(s, "disarmed");
  assert.equal(
    s.goalActivationBySession[SID],
    "disarmed",
    "后续 disarmed 边覆盖",
  );
  s = edge(s, "armed");
  assert.equal(s.goalActivationBySession[SID], "armed", "再次 armed 覆盖");
  // 其它会话：同一份 state 里各存各的（切走再切回时仍显原值）
  s = reduceState(s, {
    type: "goal-activation",
    sessionId: "s2",
    activation: "disarmed",
  });
  assert.deepEqual(
    [s.goalActivationBySession[SID], s.goalActivationBySession["s2"]],
    ["armed", "disarmed"],
    "按会话隔离",
  );
});

test("goal-activation reducer: 无 activation = 宿主已无当前 goal → 清该会话记录", () => {
  let s = withGoal("active");
  s = edge(s, "armed");
  s = reduceState(s, {
    type: "goal-activation",
    sessionId: "s2",
    activation: "armed",
  });
  s = edge(s); // s1 端清
  assert.equal(s.goalActivationBySession[SID], undefined, "s1 记录被清");
  assert.equal(s.goalActivationBySession["s2"], "armed", "其它会话不受影响");
  // 清空后再来一条边 → 重新建立记录
  s = edge(s, "disarmed");
  assert.equal(s.goalActivationBySession[SID], "disarmed");
});

test("activeGoalActivation: 非 active 相位 / 无 goal / 无会话 → 不显示（undefined）", () => {
  assert.equal(
    activeGoalActivation(withGoal("paused"), SID),
    undefined,
    "paused 相位不显示开关",
  );
  assert.equal(
    activeGoalActivation(withGoal("complete"), SID),
    undefined,
    "complete 相位不显示开关",
  );
  assert.equal(
    activeGoalActivation(initialState(), SID),
    undefined,
    "无 goal 不显示",
  );
  assert.equal(
    activeGoalActivation(withGoal("active"), undefined),
    undefined,
    "无会话不显示",
  );
});

test("activeGoalActivation: 重启回归——只有 create(active)、零 activation 边 → disarmed", () => {
  const s = withGoal("active");
  assert.equal(
    activeGoalActivation(s, SID),
    "disarmed",
    "无记录推导为 disarmed（重启后宿主为 disarmed 且不发事件）",
  );
});

test("activeGoalActivation: 收到边后取展示值；resume 序列（disarmed → armed）转绿", () => {
  let s = withGoal("active");
  s = edge(s, "disarmed");
  assert.equal(activeGoalActivation(s, SID), "disarmed", "disarmed 边");
  // resume（人类直接请求）→ 宿主 setActivation(armed) → armed 边
  s = edge(s, "armed");
  assert.equal(activeGoalActivation(s, SID), "armed", "resume 后转 armed");
  // 相位变更不携带 activation，故保留原边（edit 语义：宿主不改 activation）
  s = reduceState(s, {
    type: "goal-change",
    sessionId: SID,
    operation: "edit",
    goal: { id: "g1", revision: 2, objective: "改后的目标", phase: "active" },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(activeGoalActivation(s, SID), "armed", "edit 不改 activation");
});

test("activeGoalActivation: activation 边先于 goal/change 到达也保留（顺序无关）", () => {
  // 宿主真实顺序可能先发 activation 边再发 goal/change；reducer 只存原始边，故两步互换结果一致
  let s = reduceState(initialState(), {
    type: "goal-activation",
    sessionId: SID,
    activation: "armed",
  });
  assert.equal(activeGoalActivation(s, SID), undefined, "无 goal 时不显示");
  s = reduceState(s, {
    type: "goal-change",
    sessionId: SID,
    operation: "create",
    goal: { id: "g1", revision: 1, objective: "目标", phase: "active" },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(
    activeGoalActivation(s, SID),
    "armed",
    "goal 到达后沿用先到的边",
  );
});

test("端到端：activation 事件经 App 走到状态列（回放路径灰 ⟳ → armed 绿 ⟳）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  const frame = (): string => renderer.lastRender.join("\n");
  const plain = (): string => frame().replace(/\x1b\[[0-9;]*m/g, "");
  try {
    // 只有 goal/change（回放 / 重启后宿主不发 activation 边）→ 推导 disarmed
    adapter.push({
      type: "goal-change",
      sessionId: SID,
      operation: "create",
      goal: { id: "g1", revision: 1, objective: "目标", phase: "active" },
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    await sleep(0);
    assert.ok(
      plain().includes("Goal ▷ ⟳"),
      "无 activation 记录仍显示 ⟳（灰色）: " + plain(),
    );
    assert.ok(
      frame().includes(sgrOf("gray") + " ⟳"),
      "disarmed 推导为灰: " + frame(),
    );
    // armed 边 → 转绿（该用例同时守 index.ts 的事件分派与 buildTopRegion 的接线）
    adapter.push({
      type: "goal-activation",
      sessionId: SID,
      activation: "armed",
    });
    await sleep(0);
    assert.ok(
      frame().includes(sgrOf("green") + " ⟳"),
      "armed 边后转绿: " + frame(),
    );
  } finally {
    app.dispose();
  }
});
