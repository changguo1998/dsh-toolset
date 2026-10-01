// tests/adapter-steer.test.ts — real adapter 的 steer 派发（BACKLOG TUI#36 真机缺陷回归）
//
// 背景：`<` 提交在真机恒降级成普通 followup——根因是 adapter 只看**瘦 agent**
// （`opts.agent`，main.ts/resumeTo 里只转发 followup），而 steer 只存在于宿主**原始 agent**。
// 本用例锁死契约：canSteer() 与 sendMessage(target='next-step') 都必须优先看原始 agent。

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRealDshAdapter } from "../src/app/adapter/dsh.ts";
import type { DshAgentLike, DshRuntime } from "../src/app/adapter/dsh.ts";

/** 最小 runtime 桩：adapter 只用到 on/get（服务全部缺失 → 走降级分支） */
function stubRuntime(): DshRuntime {
  return {
    on: () => () => {},
    get: () => undefined,
  } as unknown as DshRuntime;
}

/** 瘦 agent（与 main.ts 同形：只转发 followup） */
function thinAgent(calls: string[]): DshAgentLike {
  return {
    session: { id: "s1" },
    followup: () => calls.push("thin-followup"),
  };
}

test("steer：原始宿主 agent 有 steer → canSteer() true，next-step 走 steer 而非 followup", () => {
  const calls: string[] = [];
  const adapter = createRealDshAdapter({
    runtime: stubRuntime(),
    sessionId: "s1",
    agent: thinAgent(calls),
    commandAgent: {
      session: { id: "s1" },
      followup: () => calls.push("raw-followup"),
      steer: () => calls.push("raw-steer"),
    },
    handleDispose: () => Promise.resolve(),
  });
  assert.equal(adapter.canSteer?.(), true, "canSteer 必须看原始 agent");
  adapter.sendMessage("快点改", undefined, "next-step");
  assert.deepEqual(calls, ["raw-steer"], "next-step 投递走原始 agent.steer");
  // 普通投递不受影响（仍走瘦 agent 的 followup）
  adapter.sendMessage("普通消息", undefined);
  assert.deepEqual(calls, ["raw-steer", "thin-followup"]);
  adapter.dispose?.();
});

test("steer：宿主无 steer（旧版）→ canSteer() false，next-step 降级 followup", () => {
  const calls: string[] = [];
  const adapter = createRealDshAdapter({
    runtime: stubRuntime(),
    sessionId: "s1",
    agent: thinAgent(calls),
    commandAgent: {
      session: { id: "s1" },
      followup: () => calls.push("raw-followup"),
    },
    handleDispose: () => Promise.resolve(),
  });
  assert.equal(
    adapter.canSteer?.(),
    false,
    "两层都没有 steer → 能力为 false（App 会给降级提示）",
  );
  adapter.sendMessage("降级消息", undefined, "next-step");
  assert.deepEqual(calls, ["thin-followup"], "降级走 followup，消息不丢");
  adapter.dispose?.();
});

test("kickoff：原始宿主 agent 有 steer → 自检消息走 steer 而非 followup（BACKLOG #2）", () => {
  const calls: string[] = [];
  const steered: unknown[] = [];
  const adapter = createRealDshAdapter({
    runtime: stubRuntime(),
    sessionId: "s1",
    agent: thinAgent(calls),
    commandAgent: {
      session: { id: "s1" },
      followup: () => calls.push("raw-followup"),
      steer: (m: unknown) => {
        calls.push("raw-steer");
        steered.push(m);
      },
    },
    handleDispose: () => Promise.resolve(),
  });
  adapter.sendBootstrapKickoff?.();
  assert.deepEqual(
    calls,
    ["raw-steer"],
    "kickoff 走 steer（投递到最近 step 边界）",
  );
  const msg = steered[0] as { source?: { kind?: string } };
  assert.equal(
    msg.source?.kind,
    "tool-bootstrap",
    "仍是启动自检消息（source.kind 不变）",
  );
  adapter.dispose?.();
});

test("kickoff：宿主无 steer → 回落 followup，消息不丢（BACKLOG #2 降级分支）", () => {
  const calls: string[] = [];
  const adapter = createRealDshAdapter({
    runtime: stubRuntime(),
    sessionId: "s1",
    agent: thinAgent(calls),
    commandAgent: {
      session: { id: "s1" },
      followup: () => calls.push("raw-followup"),
    },
    handleDispose: () => Promise.resolve(),
  });
  adapter.sendBootstrapKickoff?.();
  assert.deepEqual(calls, ["thin-followup"], "无 steer 的宿主回落到 followup");
  adapter.dispose?.();
});

test("steer：只有瘦 agent 暴露 steer（无原始 agent）时仍可用（兼容口径）", () => {
  const calls: string[] = [];
  const thin: DshAgentLike = {
    session: { id: "s1" },
    followup: () => calls.push("thin-followup"),
    steer: () => calls.push("thin-steer"),
  };
  const adapter = createRealDshAdapter({
    runtime: stubRuntime(),
    sessionId: "s1",
    agent: thin,
    handleDispose: () => Promise.resolve(),
  });
  assert.equal(adapter.canSteer?.(), true);
  adapter.sendMessage("走 steer", undefined, "next-step");
  assert.deepEqual(calls, ["thin-steer"]);
  adapter.dispose?.();
});
