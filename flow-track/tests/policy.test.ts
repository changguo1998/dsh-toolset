import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_NAMES,
  WHOLE_STAGE,
  decideRecord,
  decideRollback,
  hasActiveFlow,
  latestStageRecord,
  stageIndex,
} from "../src/policy.ts";
import type { FlowRecord } from "../src/store.ts";

/** 造一条时间线记录（顺序即 id 顺序）。 */
function rec(id: number, stage: string): FlowRecord {
  return {
    id,
    slug: "demo",
    stage,
    status: "start",
    body: "",
    createdAt: id,
  };
}

test("八阶段表：顺序固定, 下标可查, - 不在表内", () => {
  assert.deepEqual(
    [...STAGE_NAMES],
    ["目标", "调研", "决策", "规划", "实现", "测试", "审查", "收尾"],
  );
  assert.equal(stageIndex("目标"), 0);
  assert.equal(stageIndex("收尾"), 7);
  assert.equal(stageIndex(WHOLE_STAGE), -1);
  assert.equal(stageIndex("阶段X"), -1);
});

test("空时间线：只接受 目标, - 与更后阶段都拒绝", () => {
  assert.deepEqual(decideRecord([], "目标"), { kind: "write", replace: false });
  const skip = decideRecord([], "调研");
  assert.equal(skip.kind, "reject");
  if (skip.kind === "reject") assert.equal(skip.error, "first_stage");
  const note = decideRecord([], WHOLE_STAGE);
  assert.equal(note.kind, "reject");
  if (note.kind === "reject") assert.equal(note.error, "first_stage");
});

test("阶段名不在八阶段内：拒绝并列出可选值", () => {
  const policy = decideRecord([rec(1, "目标")], "阶段X");
  assert.equal(policy.kind, "reject");
  if (policy.kind === "reject") {
    assert.equal(policy.error, "invalid_stage");
    assert.match(policy.message, /目标 \/ 调研/);
  }
});

test("当前阶段：同阶段替换, 下一阶段新增, - 可备注", () => {
  const records = [rec(1, "目标")];
  assert.deepEqual(decideRecord(records, "目标"), {
    kind: "write",
    replace: true,
  });
  assert.deepEqual(decideRecord(records, "调研"), {
    kind: "write",
    replace: false,
  });
  assert.deepEqual(decideRecord(records, WHOLE_STAGE), {
    kind: "write",
    replace: false,
  });
});

test("跳过阶段：拒绝并给出当前与下一阶段名", () => {
  const policy = decideRecord([rec(1, "目标"), rec(2, "调研")], "实现");
  assert.equal(policy.kind, "reject");
  if (policy.kind === "reject") {
    assert.equal(policy.error, "skip_stage");
    assert.match(policy.message, /当前是「调研」/);
    assert.match(policy.message, /下一步只能是「决策」/);
  }
});

test("倒回阶段：拒绝并指 flow_rollback", () => {
  const policy = decideRecord([rec(1, "目标"), rec(2, "调研")], "目标");
  assert.equal(policy.kind, "reject");
  if (policy.kind === "reject") {
    assert.equal(policy.error, "rollback_needed");
    assert.match(policy.message, /flow_rollback/);
  }
});

test("- 备注不参与当前阶段推导", () => {
  const records = [rec(1, "目标"), rec(2, WHOLE_STAGE)];
  assert.equal(latestStageRecord(records)?.stage, "目标");
  assert.deepEqual(decideRecord(records, "调研"), {
    kind: "write",
    replace: false,
  });
});

test("未知当前阶段（脏数据）：拒绝并指 flow_remove", () => {
  const policy = decideRecord([rec(1, "阶段X")], "目标");
  assert.equal(policy.kind, "reject");
  if (policy.kind === "reject") {
    assert.equal(policy.error, "unknown_current");
    assert.match(policy.message, /flow_remove/);
  }
});

test("最后阶段再往后：没有下一阶段, 只允许更新自身", () => {
  const records = [rec(1, "审查"), rec(2, "收尾")];
  assert.deepEqual(decideRecord(records, "收尾"), {
    kind: "write",
    replace: true,
  });
  const policy = decideRecord(records, "收尾");
  assert.equal(policy.kind, "write");
});

test("回退判定：目标之后与 - 备注都清, 目标阶段保留", () => {
  const records = [
    rec(1, "目标"),
    rec(2, "调研"),
    rec(3, "决策"),
    rec(4, WHOLE_STAGE),
  ];
  assert.deepEqual(decideRollback(records, "调研"), {
    kind: "clear",
    ids: [3, 4],
  });
  assert.deepEqual(decideRollback(records, "目标"), {
    kind: "clear",
    ids: [2, 3, 4],
  });
});

test("回退判定：不早于当前阶段拒绝, 无记录拒绝, 坏阶段名拒绝", () => {
  const records = [rec(1, "目标"), rec(2, "调研")];
  const same = decideRollback(records, "调研");
  assert.equal(same.kind, "reject");
  if (same.kind === "reject") {
    assert.equal(same.error, "not_backward");
    assert.match(same.message, /flow_record/);
  }
  const empty = decideRollback([], "目标");
  assert.equal(empty.kind, "reject");
  if (empty.kind === "reject") assert.equal(empty.error, "no_records");
  const bad = decideRollback(records, WHOLE_STAGE);
  assert.equal(bad.kind, "reject");
  if (bad.kind === "reject") assert.equal(bad.error, "invalid_stage");
});

test("活跃流程：最新阶段不是收尾即活跃, - 备注与已收尾不算", () => {
  assert.equal(hasActiveFlow([]), false);
  assert.equal(hasActiveFlow([rec(1, "收尾")]), false);
  assert.equal(hasActiveFlow([rec(1, "目标")]), true);
  assert.equal(hasActiveFlow([rec(1, "收尾"), rec(2, WHOLE_STAGE)]), false);
  assert.equal(hasActiveFlow([rec(1, "测试"), rec(2, "收尾")]), false);
  // 任一任务没走到收尾就算活跃（项目层全部 slug）
  const other: FlowRecord = { ...rec(3, "调研"), slug: "other" };
  assert.equal(hasActiveFlow([rec(1, "收尾"), other]), true);
});
