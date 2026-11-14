import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideText,
  renderCompliance,
  renderLastRecord,
} from "../src/inject.ts";
import type { FlowRecord } from "../src/store.ts";

const RECORD: FlowRecord = {
  id: 1,
  slug: "demo",
  stage: "决策",
  status: "done",
  body: "选了 b",
  createdAt: 1,
};

test("无记录、无写类调用 → 不注入", () => {
  assert.equal(decideText({ records: [], writeSeen: false }), undefined);
});

test("无记录、有写类调用 → 只给合规提示（树级模板已退役）", () => {
  const text = decideText({
    records: [],
    writeSeen: true,
    lastWriteTool: "edit",
  });
  assert.ok(text);
  assert.match(text, /本轮已调用写类工具（edit）/);
  assert.match(text, /只提示, 不拦截/);
  assert.equal(text.includes("八阶段模板"), false);
  assert.equal(text.includes("当前阶段"), false);
});

test("有记录 → 只给最近记录摘要（不再给阶段与下一步）", () => {
  const text = decideText({
    records: [RECORD],
    writeSeen: false,
  });
  assert.ok(text);
  assert.match(text, /最近记录：demo@决策 状态 done：选了 b/);
  assert.equal(text.includes("当前阶段"), false);
  assert.equal(text.includes("下一步"), false);
});

test("有记录时写类调用不再提示合规", () => {
  const text = decideText({
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
  const text = decideText({ records: [], writeSeen: true });
  assert.ok(text);
  assert.equal(text.includes("最近记录"), false);
});
