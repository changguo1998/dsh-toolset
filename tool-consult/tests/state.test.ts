import { test } from "node:test";
import assert from "node:assert/strict";

import { RevealSet } from "../src/state.ts";

test("只增不减：重复揭示返回 already，不设容量上限", () => {
  const grants = new RevealSet();
  assert.deepEqual(grants.grant("a"), { granted: true, status: "granted" });
  assert.deepEqual(grants.grant("a"), { granted: false, status: "already" });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(grants.grant(`tool_${index}`).status, "granted");
  }
  assert.equal(grants.size(), 21);
  assert.deepEqual(grants.names(), [
    "a",
    "tool_0",
    "tool_1",
    "tool_10",
    "tool_11",
    "tool_12",
    "tool_13",
    "tool_14",
    "tool_15",
    "tool_16",
    "tool_17",
    "tool_18",
    "tool_19",
    "tool_2",
    "tool_3",
    "tool_4",
    "tool_5",
    "tool_6",
    "tool_7",
    "tool_8",
    "tool_9",
  ]);
});

test("forget 只移除指定项", () => {
  const grants = new RevealSet();
  grants.grant("a");
  grants.grant("b");
  assert.equal(grants.forget("a"), true);
  assert.equal(grants.forget("a"), false);
  assert.equal(grants.has("a"), false);
  assert.equal(grants.has("b"), true);
});

test("运行时隔离：两个实例互不影响", () => {
  const first = new RevealSet();
  const second = new RevealSet();
  first.grant("a");
  assert.equal(second.has("a"), false);
  assert.equal(second.size(), 0);
});
