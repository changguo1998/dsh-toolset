import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideText,
  renderCompliance,
  renderLastRecord,
} from "../src/inject.ts";
import type { FlowRecord } from "../src/store.ts";
import type { SnapshotLike } from "../src/status.ts";

/** 造一份有阶段树的快照（当前阶段 = `stage`）。 */
function snapshotOf(stage: string): SnapshotLike {
  return {
    tasks: [
      {
        id: "root",
        title: "任务",
        status: "active",
        children: [{ id: "c", title: stage, status: "active", children: [] }],
      },
    ],
    frameStack: ["c"],
    activeCount: 1,
    isComplete: false,
  };
}

const RECORD: FlowRecord = {
  id: 1,
  slug: "demo",
  stage: "决策",
  status: "done",
  body: "选了 b",
  createdAt: 1,
};

test("无阶段树、无写类调用 → 不注入", () => {
  assert.equal(decideText({ records: [], writeSeen: false }), undefined);
});

test("无阶段树、有写类调用 → 模板 + 合规提示", () => {
  const text = decideText({
    records: [],
    writeSeen: true,
    lastWriteTool: "edit",
  });
  assert.ok(text);
  assert.match(text, /标准流程八阶段模板/);
  assert.match(text, /本轮已调用写类工具（edit）/);
  assert.match(text, /只提示, 不拦截/);
});

test("有阶段树 → 给当前阶段与下一步", () => {
  const text = decideText({
    snapshot: snapshotOf("决策"),
    records: [],
    writeSeen: false,
  });
  assert.ok(text);
  assert.match(text, /当前阶段：3\/8 决策/);
  assert.match(text, /下一步：阶段 4 规划/);
  assert.equal(text.includes("标准流程八阶段模板"), false);
});

test("有阶段树 + 有记录 → 追加最近记录摘要", () => {
  const text = decideText({
    snapshot: snapshotOf("实现"),
    records: [RECORD],
    writeSeen: false,
  });
  assert.ok(text);
  assert.match(text, /最近记录：demo@决策 状态 done：选了 b/);
});

test("合规提示：已有流程记录就不再提示", () => {
  const text = decideText({
    snapshot: snapshotOf("实现"),
    records: [RECORD],
    writeSeen: true,
    lastWriteTool: "bash",
  });
  assert.ok(text);
  assert.equal(text.includes("本轮已调用写类工具"), false);
});

test("合规提示单独渲染时的措辞", () => {
  const text = renderCompliance({ records: [], writeSeen: true });
  assert.ok(text);
  assert.match(text, /本轮已调用写类工具/);
  assert.equal(text.includes("（"), false);
});

test("最近记录：长正文截断到 120 字", () => {
  const line = renderLastRecord({
    ...RECORD,
    body: "x".repeat(200),
  });
  assert.ok(line);
  assert.ok(line.endsWith("…"));
  assert.equal(line.length < 200, true);
});

test("最近记录：空正文不拼冒号段", () => {
  const line = renderLastRecord({ ...RECORD, body: "" });
  assert.equal(line, "最近记录：demo@决策 状态 done");
});

test("无记录时没有「最近记录」行", () => {
  const text = decideText({
    snapshot: snapshotOf("目标"),
    records: [],
    writeSeen: false,
  });
  assert.ok(text);
  assert.equal(text.includes("最近记录"), false);
});
