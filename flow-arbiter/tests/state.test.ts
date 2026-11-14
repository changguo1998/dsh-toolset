import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_FLOWS, FlowArbiterState } from "../src/state.ts";

test("选中 / 取消 / 会话隔离：状态只在内存, 一会话一份", () => {
  const state = new FlowArbiterState();
  assert.deepEqual(
    DEFAULT_FLOWS.map((flow) => flow.entry),
    ["flow_start", "plan_start"],
  );
  assert.equal(state.current("s1"), undefined);
  const selected = state.select("s1", "standard");
  assert.equal(selected.ok, true);
  assert.equal(state.current("s1")?.id, "standard");
  assert.equal(state.current("s2"), undefined, "别的会话不受影响");
  assert.equal(state.clear("s1"), true);
  assert.equal(state.current("s1"), undefined);
  assert.equal(state.clear("s1"), false, "重复取消返回 false");
});

test("唯一性 + 冲突顶替：同会话选第二个流程时顶替旧的并回报 replaced", () => {
  const state = new FlowArbiterState();
  state.select("s1", "standard");
  const result = state.select("s1", "plan");
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.flow.id : "", "plan");
  assert.equal(result.ok ? result.replaced?.id : undefined, "standard");
  assert.equal(state.current("s1")?.id, "plan");
  // 选同一个不算顶替
  const same = state.select("s1", "plan");
  assert.equal(same.ok ? same.replaced : "x", undefined);
});

test("未知流程：拒绝并列出可选项", () => {
  const state = new FlowArbiterState();
  const result = state.select("s1", "nope");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error : "", "unknown_flow");
  assert.match(result.ok === false ? result.message : "", /standard/);
  assert.equal(state.current("s1"), undefined);
});

test("登记：新流程可选中, 重复入口与非法登记被拒", () => {
  const state = new FlowArbiterState();
  assert.deepEqual(state.register({ id: "a", name: "甲", entry: "a_start" }), {
    ok: true,
  });
  assert.equal(state.flowByEntry("a_start")?.id, "a");
  assert.equal(state.select("s1", "a").ok, true);
  const duplicate = state.register({ id: "b", name: "乙", entry: "a_start" });
  assert.equal(duplicate.ok, false);
  assert.equal(
    duplicate.ok === false ? duplicate.error : "",
    "duplicate_entry",
  );
  const invalid = state.register({ id: "", name: "丙", entry: "c_start" });
  assert.equal(
    invalid.ok === false ? invalid.error : "",
    "invalid_registration",
  );
  assert.equal(state.list().length, 3, "两条内置 + 一条新登记");
});

test("入口裁决：非入口工具跳过, 未选中 / 选别的拒绝, 选中放行", () => {
  const state = new FlowArbiterState();
  assert.deepEqual(state.decide("s1", "task_status"), { kind: "skip" });
  const none = state.decide("s1", "flow_start");
  assert.equal(none.kind, "deny");
  assert.match(none.kind === "deny" ? none.reason : "", /未选中流程/);
  state.select("s1", "plan");
  const other = state.decide("s1", "flow_start");
  assert.equal(other.kind, "deny");
  assert.match(other.kind === "deny" ? other.reason : "", /plan 模式三段/);
  assert.deepEqual(state.decide("s1", "plan_start"), { kind: "allow" });
  assert.equal(state.decide("s2", "flow_start").kind, "deny", "别的会话未选中");
});

test("入口裁决：认不出会话就拒绝（不默认放行）", () => {
  const state = new FlowArbiterState();
  state.select("s1", "standard");
  const decision = state.decide(undefined, "flow_start");
  assert.equal(decision.kind, "deny");
  assert.match(decision.kind === "deny" ? decision.reason : "", /会话归属/);
});
