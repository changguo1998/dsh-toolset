import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prefixOverlap,
  estimateHitRate,
  actualHitRate,
} from "../src/overlap.ts";
import {
  createMonitorState,
  recordSnapshot,
  endStep,
  dropState,
} from "../src/monitor.ts";

const msg = (id: string, text = "x") => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
});

function step(
  state: ReturnType<typeof createMonitorState>,
  opts: Parameters<typeof endStep>[1],
) {
  return endStep(state, opts);
}

test("overlap: 前缀重叠按 role+content 深比较", () => {
  const a = [msg("a1", "hi"), msg("a2", "yo")];
  const b = [msg("b1", "hi"), msg("b2", "other")];
  assert.equal(prefixOverlap(a, b), 1);
  assert.equal(prefixOverlap([], a), 0);
  assert.equal(prefixOverlap(a, []), 0);
  // source/id 不同不影响（canonical 只取 role+content）
  const c = [msg("c1", "hi"), msg("a2", "yo")];
  assert.equal(prefixOverlap(a, c), 2);
  // 内容顺序敏感（前缀语义）
  const d = [msg("d1", "yo"), msg("d2", "hi")];
  assert.equal(prefixOverlap(a, d), 0);
});

test("estimateHitRate / actualHitRate", () => {
  assert.equal(estimateHitRate(2, 4), 0.5);
  assert.equal(estimateHitRate(0, 5), 0);
  assert.equal(estimateHitRate(3, 0), 0);
  assert.equal(actualHitRate(70, 30), 0.7);
  assert.equal(actualHitRate(0, 0), 0);
});

test("endStep: 首次（无上次快照）→ first, 运行最低基线 0, 豁免偏差判定", () => {
  const state = createMonitorState();
  recordSnapshot(new Map([["s1", state]]), "s1", [msg("a1")]);
  const out = step(state, { tolerance: 0.3, firstStepOnly: false });
  assert.equal(out.state, "first");
  assert.equal(out.estimated, undefined);
  assert.equal(state.runMinActual, 0);
  assert.equal(state.runMinReal, false);
  // 首次后 last 已提升, 下一步有基线
  assert.equal(state.lastSnapshot!.length, 1);
});

test("endStep: 首步无上次快照但已有真实 usage → runMin 由真实值接管", () => {
  const state = createMonitorState();
  recordSnapshot(new Map([["s1", state]]), "s1", [msg("a1")]);
  const out = step(state, {
    tolerance: 0.3,
    firstStepOnly: false,
    cacheRead: 10,
    input: 90,
  });
  assert.equal(out.state, "first"); // 首步仍 first（无预估基线）
  assert.equal(state.runMinActual, 0.1);
  assert.equal(state.runMinReal, true);
});

test("endStep: 正常——偏差在容差内 → normal, 运行最低刷新", () => {
  const state = createMonitorState();
  const states = new Map([["s1", state]]);
  recordSnapshot(states, "s1", [msg("a1"), msg("a2")]);
  step(state, { tolerance: 0.3, firstStepOnly: false }); // 首次, runMin=0
  // 第二步: 完全重合（last/current 各 2 条同内容）→ 预估 1.0; 实际 0.8 → 偏差 0.2 < 0.3 → normal
  recordSnapshot(states, "s1", [msg("b1"), msg("b2")]);
  const out = step(state, {
    tolerance: 0.3,
    firstStepOnly: false,
    cacheRead: 8,
    input: 2,
  });
  assert.equal(out.state, "normal");
  assert.equal(out.estimated, 1);
  assert.equal(state.runMinActual, 0.8); // 首个真实值接管, 不再停在 0
});

test("endStep: 失效——偏差超阈值 → stale", () => {
  const state = createMonitorState();
  const states = new Map([["s1", state]]);
  recordSnapshot(states, "s1", [msg("a1"), msg("a2")]);
  step(state, { tolerance: 0.3, firstStepOnly: false });
  // 第二步: 前缀完全一样 → 预估 1.0; 实际 0.0 → 偏差 1.0 > 0.3 → stale
  recordSnapshot(states, "s1", [msg("b1"), msg("b2")]);
  const out = step(state, {
    tolerance: 0.3,
    firstStepOnly: false,
    cacheRead: 0,
    input: 100,
  });
  assert.equal(out.state, "stale");
  assert.equal(state.runMinActual, 0);
});

test("endStep: 无 usage → 有预估但无实际, 不刷新 runMin", () => {
  const state = createMonitorState();
  const states = new Map([["s1", state]]);
  recordSnapshot(states, "s1", [msg("a1")]);
  step(state, { tolerance: 0.3, firstStepOnly: false });
  assert.equal(state.runMinActual, 0);
  // 第二步无 usage: 有预估无实际 → 保守 normal（无实际数据→无偏差→不告警）
  recordSnapshot(states, "s1", [msg("b1"), msg("b2")]);
  const out = step(state, { tolerance: 0.3, firstStepOnly: false });
  assert.equal(out.state, "normal");
  assert.equal(out.actual, undefined);
  assert.equal(state.runMinActual, 0); // 无真实数据, 不刷新
});

test("endStep: 只盯第一步——第一步之后不再更新状态位", () => {
  const state = createMonitorState();
  const states = new Map([["s1", state]]);
  recordSnapshot(states, "s1", [msg("a1")]);
  const first = step(state, { tolerance: 0.3, firstStepOnly: true });
  assert.equal(first.state, "first");
  recordSnapshot(states, "s1", [msg("b1"), msg("b2")]);
  const second = step(state, {
    tolerance: 0.3,
    firstStepOnly: true,
    cacheRead: 0,
    input: 100,
  });
  // firstStepOnly 时第二步不更新 lastOutcome, 保持 first
  assert.equal(state.lastOutcome!.state, "first");
  assert.equal(second.state, "stale"); // 返回本次判定, 但外部引用应读 state.lastOutcome
});

test("endStep: 运行最低不回退不抖动（取最小值）", () => {
  const state = createMonitorState();
  const states = new Map([["s1", state]]);
  recordSnapshot(states, "s1", [msg("a1")]);
  step(state, { tolerance: 0.3, firstStepOnly: false });
  recordSnapshot(states, "s1", [msg("b1"), msg("b2")]);
  step(state, {
    tolerance: 0.3,
    firstStepOnly: false,
    cacheRead: 80,
    input: 20,
  }); // 0.8
  assert.equal(state.runMinActual, 0.8);
  recordSnapshot(states, "s1", [msg("c1"), msg("c2"), msg("c3")]);
  step(state, {
    tolerance: 0.3,
    firstStepOnly: false,
    cacheRead: 40,
    input: 60,
  }); // 0.4
  assert.equal(state.runMinActual, 0.4); // 更低 → 刷新
  recordSnapshot(states, "s1", [msg("d1"), msg("d2"), msg("d3"), msg("d4")]);
  step(state, {
    tolerance: 0.3,
    firstStepOnly: false,
    cacheRead: 90,
    input: 10,
  }); // 0.9
  assert.equal(state.runMinActual, 0.4); // 更高 → 不回退
});

test("dropState: 清理会话状态", () => {
  const states = new Map<string, ReturnType<typeof createMonitorState>>();
  recordSnapshot(states, "s1", [msg("x")]);
  assert.equal(dropState(states, "s1"), true);
  assert.equal(dropState(states, "s1"), false);
});
