// task-engine/tests/order.test.ts — 顺序强制（决策项 1-3）：三入口 × 关 / 开两态、作用域与失败兄弟
//
// 覆盖口径：缺省关闭时既有行为逐字不变；打开后 implement / execute / stop 一律拦在
// 「前序兄弟未 done」上（打回指向本帧、不烧重试计数）；约束只在同父兄弟序列内成立。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TaskEngine } from "../src/engine.ts";
import type { AcceptanceHooks } from "../src/acceptance.ts";
import type { ChildSpec, FrameId } from "../src/types.ts";

const mech = (
  id: string,
  command = "true",
): ChildSpec["acceptance"][number] => ({
  id,
  check: `验收 ${id}`,
  level: "mechanical",
  command,
});

function makeHooks(over?: Partial<AcceptanceHooks>): AcceptanceHooks {
  return {
    runCommand: async (cmd) =>
      cmd === "true" ? { code: 0 } : { code: 1, output: "fail" },
    approve: async () => true,
    ...over,
  };
}

/** 子任务（缺省叶子；`order` 为顺序强制声明）。 */
function child(id: FrameId, extra: Partial<ChildSpec> = {}): ChildSpec {
  return {
    id,
    title: id,
    spec: `做 ${id}`,
    acceptance: [],
    needDecompose: false,
    coverage: {},
    ...extra,
  };
}

/** 带顺序强制声明的子任务（流程定义建树时的形态）。 */
function ordered(id: FrameId, extra: Partial<ChildSpec> = {}): ChildSpec {
  return child(id, { enforceOrder: true, ...extra });
}

/** 引擎（根无验收，避免 coverage 噪音；`maxRetries` 由用例按需收紧）。 */
function newEngine(
  opts: { enforceOrder?: boolean; maxRetries?: number } = {},
): TaskEngine {
  return new TaskEngine({
    root: {
      id: "root",
      title: "R",
      spec: "根目标",
      acceptance: [],
      ...(opts.enforceOrder === true ? { enforceOrder: true } : {}),
    },
    ...makeHooks(),
    ...(opts.maxRetries === undefined
      ? {}
      : { gate: { maxRetries: opts.maxRetries } }),
  });
}

describe("顺序强制: 缺省关闭（既有行为逐字不变）", () => {
  it("未声明 enforceOrder: 前序兄弟未完成也可 implement 与 stop", async () => {
    const e = newEngine();
    const d = await e.composeFromNodes("root", [child("c1"), child("c2")]);
    assert.equal(d.ok, true);
    assert.equal(e.implement("c2", "先做 c2").ok, true);
    const s = await e.stop("c2");
    assert.equal(s.ok, true);
    assert.equal(e.frames().get("c1")?.status, "pending", "前序兄弟未受影响");
    assert.equal(e.frames().get("c2")?.status, "done");
  });
});

describe("顺序强制: 打开（帧自带声明）", () => {
  it("前序兄弟未 done: 拒绝 implement, 打回指向本帧且不烧重试计数", async () => {
    const e = newEngine();
    await e.composeFromNodes("root", [ordered("c1"), ordered("c2")]);
    const r = e.implement("c2", "抢跑");
    assert.equal(r.ok, false);
    assert.match(
      r.ok === false ? r.feedback : "",
      /c2 受顺序强制约束：前序兄弟 c1「c1」（pending）\s*尚未完成，不允许 implement/,
    );
    assert.equal(e.frames().get("c2")?.result, undefined, "未写入产出");
    assert.equal(e.frames().get("c2")?.retryCount, 0, "拒绝不计重试");
    // step 裁决留痕（事件流可见），不改帧状态
    const verdicts = e.log.filter(
      (ev) => ev.type === "plan/step-verdict" && ev.frame === "c2",
    );
    assert.equal(verdicts.length, 1);
  });

  it("前序兄弟 done 后放行: implement → stop → 再进下一节点", async () => {
    const e = newEngine();
    await e.composeFromNodes("root", [ordered("c1"), ordered("c2")]);
    assert.equal(e.implement("c1", "产物 1").ok, true);
    assert.equal((await e.stop("c1")).ok, true);
    const r = e.implement("c2", "产物 2");
    assert.equal(r.ok, true, "前序 done 后不再拦");
    assert.equal((await e.stop("c2")).ok, true);
    assert.equal(e.isComplete(), true);
  });

  it("前序兄弟未 done: 拒绝 execute（不发起执行面）", async () => {
    const e = newEngine();
    let started = 0;
    await e.composeFromNodes("root", [
      ordered("c1"),
      ordered("c2", { executor: { kind: "command", command: "echo hi" } }),
    ]);
    const r = await e.execute("c2", async () => {
      started += 1;
      return { ok: true, result: "不应发生" };
    });
    assert.equal(r.ok, false);
    assert.equal(r.next, "c2", "打回指向本帧");
    assert.match(r.feedback ?? "", /不允许 execute/);
    assert.equal(started, 0, "执行面未发起");
  });

  it("前序兄弟未 done: 拒绝 stop（不许提前标完成）", async () => {
    const e = newEngine();
    await e.composeFromNodes("root", [ordered("c1"), ordered("c2")]);
    const s = await e.stop("c2");
    assert.equal(s.ok, false);
    assert.equal(s.next, "c2");
    assert.match(s.feedback ?? "", /不允许 stop/);
    assert.equal(e.frames().get("c2")?.status, "pending", "状态未变");
  });
});

describe("顺序强制: 父帧声明（根契约 / 待分解节点）", () => {
  it("根契约 enforceOrder: 根的子节点按序强制（无需节点自带声明）", async () => {
    const e = newEngine({ enforceOrder: true });
    await e.composeFromNodes("root", [child("c1"), child("c2")]);
    const r = e.implement("c2", "抢跑");
    assert.equal(r.ok, false);
    assert.match(r.feedback, /前序兄弟 c1/);
  });

  it("作用域 = 同父兄弟: 别的父帧下的节点不受约束", async () => {
    const e = newEngine();
    await e.composeFromNodes("root", [
      child("p1", { needDecompose: true }),
      child("p2", { needDecompose: true }),
    ]);
    await e.composeFromNodes("p1", [ordered("a1"), ordered("a2")]);
    await e.composeFromNodes("p2", [child("b1"), child("b2")]);
    // 不跨父：p2 下的 b2 不受 p1 下 a1（未完成）约束
    assert.equal(e.implement("b2", "做 b2").ok, true);
    // 同父仍受约束
    assert.equal(e.implement("a2", "抢跑").ok, false);
  });

  it("前序兄弟 failed 也算未完成（阻塞并说明状态）", async () => {
    const e = newEngine({ maxRetries: 1 });
    await e.composeFromNodes("root", [
      ordered("c1", { acceptance: [mech("q1", "false")] }),
      ordered("c2"),
    ]);
    e.implement("c1", "产物 1");
    const s = await e.stop("c1");
    assert.equal(s.ok, false);
    assert.equal(e.frames().get("c1")?.status, "failed");
    const r = e.implement("c2", "抢跑");
    assert.equal(r.ok, false);
    assert.match(r.feedback, /前序兄弟 c1「c1」（failed）\s*尚未完成/);
  });
});
