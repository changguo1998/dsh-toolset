// tests/pipeline-sections.test.ts — 六步流水线第 1 步「接收」的契约
//
// 契约（追踪文档「分节规则」「节内合并」「三张记账表」）：
// ① 两条线（实时增量 / 结算整块）重复交付同一块**只入一次**；
// ② 节内按来源类型归并（`r1 a1 r2 a2` → reasoning = r1+r2、assistant = a1+a2），顺序按首现；
// ③ 惰性开节：只有 `step/start` 时**无空节**；
// ④ 工具批按 `callId` 配对，结果到齐 → 置「待开节」（下一块内容另起一节）；
// ⑤ 用户输入 / notice / shell 各自独立成节；
// ⑥ 冻结：封闭节即定型；当前节待定型信号（`assistant/message`）到帧边界才冻结，
//    其后若仍有追加则撤销冻结。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allSections,
  applyAll,
  applyDelivery,
  createSections,
  freezeAtFrameBoundary,
  itemOf,
} from "../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";

/** 文本块增量交付 */
const delta = (
  index: number,
  source: "assistant" | "reasoning",
  text: string,
): BlockDelivery => ({ kind: "text", turn: 1, step: 1, index, source, text });

/** 文本块整块结算交付 */
const full = (
  index: number,
  source: "assistant" | "reasoning",
  text: string,
): BlockDelivery => ({
  kind: "text",
  turn: 1,
  step: 1,
  index,
  source,
  text,
  full: true,
});

test("① 重复交付只入一次：增量 + 结算整块不重复；同一增量重放不重复", () => {
  const s = applyAll(createSections(), [
    delta(0, "assistant", "你"),
    delta(0, "assistant", "好"),
    full(0, "assistant", "你好"),
    // 旧线与新线交叉重放：已交付的增量再次到达
    delta(0, "assistant", "你"),
    delta(0, "assistant", "好"),
  ]);
  const [section] = allSections(s);
  assert.ok(section, "有节");
  assert.equal(itemOf(section, "assistant")?.text, "你好");
  assert.equal(section.items.length, 1, "同一来源只有一个条目");
});

test("① 结算整块先到、增量后到：增量不再入账", () => {
  const s = applyAll(createSections(), [
    full(0, "assistant", "完整正文"),
    delta(0, "assistant", "完整"),
  ]);
  const [section] = allSections(s);
  assert.equal(itemOf(section!, "assistant")?.text, "完整正文");
});

test("① 结算补齐缺失后缀：已交付前缀 + 更长整块 → 只补后缀", () => {
  const s = applyAll(createSections(), [
    delta(0, "assistant", "前半"),
    full(0, "assistant", "前半后半"),
  ]);
  const [section] = allSections(s);
  assert.equal(itemOf(section!, "assistant")?.text, "前半后半");
});

test("② 节内归并：reasoning / assistant 交错不被切断，顺序按首现", () => {
  const s = applyAll(createSections(), [
    delta(0, "reasoning", "r1"),
    delta(1, "assistant", "a1"),
    delta(2, "reasoning", "r2"),
    delta(3, "assistant", "a2"),
  ]);
  const [section] = allSections(s);
  assert.deepEqual(
    section?.items.map((item) => [item.source, item.text]),
    [
      ["reasoning", "r1r2"],
      ["assistant", "a1a2"],
    ],
  );
});

test("③ 惰性开节：只有 step/start 时无空节", () => {
  const s = applyDelivery(createSections(), {
    kind: "step-start",
    turn: 1,
    step: 1,
    time: 1,
  });
  assert.deepEqual(allSections(s), []);
  // 时间戳留到开节时取用
  const withText = applyDelivery(s, delta(0, "assistant", "正文"));
  assert.equal(allSections(withText)[0]?.time, 1);
});

test("③ step 变化即边界：不同 step 的内容不并进同一节", () => {
  const s = applyAll(createSections(), [
    delta(0, "assistant", "第一步"),
    { kind: "step-start", turn: 1, step: 2 },
    {
      kind: "text",
      turn: 1,
      step: 2,
      index: 0,
      source: "assistant",
      text: "第二步",
    },
  ]);
  const sections = allSections(s);
  assert.equal(sections.length, 2);
  assert.deepEqual(
    sections.map((section) => section.step),
    [1, 2],
  );
});

test("④ 工具批：一条节内多调用同批，结果到齐置待开节（下一块另起一节）", () => {
  const s = applyAll(createSections(), [
    {
      kind: "tool-call",
      turn: 1,
      step: 1,
      callId: "c1",
      name: "bash",
      args: '{"cmd":"a"}',
    },
    {
      kind: "tool-call",
      turn: 1,
      step: 1,
      callId: "c2",
      name: "read",
      args: '{"path":"b"}',
    },
    {
      kind: "tool-result",
      turn: 1,
      step: 1,
      callId: "c1",
      ok: true,
      detail: "ok",
    },
  ]);
  assert.equal(allSections(s).length, 1, "结果未到齐 → 仍是同一节");
  assert.equal(s.awaitingResults.size, 1, "还等 c2");

  const done = applyDelivery(s, {
    kind: "tool-result",
    turn: 1,
    step: 1,
    callId: "c2",
    ok: false,
    detail: "boom",
  });
  assert.equal(done.awaitingResults.size, 0);
  assert.equal(done.pendingOpen, true, "结果到齐 → 待开节");

  const [batch] = allSections(done);
  const tool = itemOf(batch!, "tool");
  assert.deepEqual(
    tool?.calls?.map((call) => call.callId),
    ["c1", "c2"],
  );
  assert.deepEqual(
    tool?.results?.map((result) => [result.callId, result.ok]),
    [
      ["c1", true],
      ["c2", false],
    ],
  );

  // 下一块内容另起一节
  const next = applyDelivery(done, delta(0, "assistant", "后续正文"));
  const sections = allSections(next);
  assert.equal(sections.length, 2);
  assert.equal(itemOf(sections[1]!, "assistant")?.text, "后续正文");
});

test("④ 工具参数按 callId 累计：分片到达只追加未覆盖后缀", () => {
  const s = applyAll(createSections(), [
    {
      kind: "tool-call",
      turn: 1,
      step: 1,
      callId: "c1",
      name: "bash",
      args: '{"cmd"',
    },
    {
      kind: "tool-call",
      turn: 1,
      step: 1,
      callId: "c1",
      name: "bash",
      args: ':"ls"}',
    },
    // 重复交付同一分片不入账
    {
      kind: "tool-call",
      turn: 1,
      step: 1,
      callId: "c1",
      name: "bash",
      args: ':"ls"}',
    },
  ]);
  assert.equal(s.toolArgs.get("c1")?.args, '{"cmd":"ls"}');
  const [section] = allSections(s);
  assert.equal(itemOf(section!, "tool")?.calls?.[0]?.args, '{"cmd":"ls"}');
});

test("④ 中断的 step 不再等批结果（结果仍配进本节）", () => {
  const s = applyAll(createSections(), [
    {
      kind: "tool-call",
      turn: 1,
      step: 1,
      callId: "c1",
      name: "bash",
      args: "{}",
    },
    { kind: "interrupted", turn: 1, step: 1 },
  ]);
  assert.equal(s.awaitingResults.size, 0, "中断后不登记待配对");
  assert.equal(s.pendingOpen, false, "中断不置待开节（结果仍属本节那批）");

  const paired = applyDelivery(s, {
    kind: "tool-result",
    turn: 1,
    step: 1,
    callId: "c1",
    ok: false,
    detail: "aborted",
  });
  const sections = allSections(paired);
  assert.equal(sections.length, 1, "结果留在本节");
  assert.equal(itemOf(sections[0]!, "tool")?.results?.[0]?.callId, "c1");
});

test("⑤ 用户输入 / notice / shell 各自独立成节", () => {
  const s = applyAll(createSections(), [
    { kind: "user", turn: 1, step: 1, text: "第一问" },
    delta(0, "assistant", "回答"),
    { kind: "notice", text: "提示", tone: "warn" },
    { kind: "shell", text: "$ ls" },
    { kind: "user", turn: 2, step: 1, text: "第二问" },
  ]);
  assert.deepEqual(
    allSections(s).map((section) => section.items.map((item) => item.source)),
    [["user"], ["assistant"], ["notice"], ["shell"], ["user"]],
  );
  assert.equal(allSections(s)[2]?.items[0]?.tone, "warn");
});

test("⑥ 冻结：封闭节立即定型；当前节待定型信号，追加则撤销冻结", () => {
  const s = applyAll(createSections(), [
    { kind: "finalize", turn: 1, step: 1 },
    delta(0, "assistant", "正文"),
  ]);
  const frozen = freezeAtFrameBoundary(s);
  assert.equal(frozen.current?.frozen, true, "定型信号 + 帧边界 → 冻结");

  const appended = applyDelivery(frozen, delta(1, "assistant", "追加"));
  assert.equal(appended.current?.frozen, false, "追加 → 撤销冻结");

  // 未收到定型信号时，帧边界不冻结
  const open = applyDelivery(createSections(), delta(0, "assistant", "正文"));
  assert.equal(freezeAtFrameBoundary(open).current?.frozen, false);

  // 封闭（用户输入打断）→ 立即定型
  const closed = applyDelivery(open, {
    kind: "user",
    turn: 1,
    step: 2,
    text: "问",
  });
  assert.equal(closed.sections[0]?.frozen, true);
});

test("③ 待开节标记只消费一次：step/start 后连续两块内容仍属同一节", () => {
  // 回归：开节时若不清 pendingOpen，第二块内容会把刚开的节又切一刀
  const s = applyAll(createSections(), [
    { kind: "step-start", turn: 1, step: 1, time: 1 },
    delta(0, "assistant", "你"),
    delta(1, "reasoning", "（想）"),
    delta(0, "assistant", "好"),
  ]);
  const sections = allSections(s);
  assert.equal(sections.length, 1, "同一 step 的内容只有一节");
  assert.deepEqual(
    sections[0]?.items.map((item) => [item.source, item.text]),
    [
      ["assistant", "你好"],
      ["reasoning", "（想）"],
    ],
  );
});
