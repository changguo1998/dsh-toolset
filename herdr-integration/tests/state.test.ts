// tests/state.test.ts — 状态推导纯函数单测（BlockTracker + desiredState）
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BlockTracker, desiredState } from "../src/state.ts";

describe("BlockTracker", () => {
  test("begin/end 成对增减，单一来源", () => {
    const blocks = new BlockTracker();
    assert.equal(blocks.blocked, false);
    blocks.begin("ask-user", "waiting for user");
    assert.equal(blocks.blocked, true);
    assert.equal(blocks.message, "waiting for user");
    blocks.end("ask-user");
    assert.equal(blocks.blocked, false);
    assert.equal(blocks.message, undefined);
  });

  test("未知来源 end 不破坏计数", () => {
    const blocks = new BlockTracker();
    blocks.end("never-began");
    assert.equal(blocks.blocked, false);
  });

  test("重复 begin 需要同等次数 end 才解除", () => {
    const blocks = new BlockTracker();
    blocks.begin("approval");
    blocks.begin("approval");
    blocks.end("approval");
    assert.equal(blocks.blocked, true);
    blocks.end("approval");
    assert.equal(blocks.blocked, false);
  });

  test("并发来源：任一活跃即阻塞，全部解除才释放", () => {
    const blocks = new BlockTracker();
    blocks.begin("ask-user", "waiting for user");
    blocks.begin("approval", "waiting for approval");
    assert.equal(blocks.blocked, true);
    blocks.end("ask-user");
    assert.equal(blocks.blocked, true);
    assert.equal(blocks.message, "waiting for approval");
    blocks.end("approval");
    assert.equal(blocks.blocked, false);
    assert.equal(blocks.message, undefined);
  });

  test("message 取最近一次 begin 的文案", () => {
    const blocks = new BlockTracker();
    blocks.begin("a", "first");
    blocks.begin("b", "second");
    assert.equal(blocks.message, "second");
  });
});

describe("desiredState", () => {
  test("blocked 优先于 working", () => {
    assert.deepEqual(desiredState(true, true, "waiting for user"), {
      state: "blocked",
      message: "waiting for user",
    });
  });

  test("agent 活跃 → working", () => {
    assert.deepEqual(desiredState(true, false), { state: "working" });
  });

  test("无活跃无阻塞 → idle", () => {
    assert.deepEqual(desiredState(false, false), { state: "idle" });
  });

  test("blocked 时可带 message，working/idle 不带", () => {
    assert.equal(
      desiredState(false, true, "waiting for approval").message,
      "waiting for approval",
    );
    assert.equal(desiredState(true, false).message, undefined);
    assert.equal(desiredState(false, false).message, undefined);
  });
});
