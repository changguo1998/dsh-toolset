// tests/pipeline-sections.test.ts — 六步流水线第 1 步「接收」的契约
//
// 契约（追踪文档「分节规则」「节内合并」「三张记账表」，含审阅后细化的两条口径）：
// ① 幂等：实时增量 / 结算整块两条线交叉、乱序、重放都只入一次（`seq` 或文本对账）；
// ② 节内按来源类型归并（`r1 a1 r2 a2` → reasoning = r1+r2、assistant = a1+a2），顺序按首现；
// ③ 惰性开节：只有 `step/start` 时**无空节**；同 (turn,step) 的重复 / 迟到 step-start 不切节；
// ④ 工具批按 `callId` 配对（结果早于调用 / 缺 callId / 跨 step 泄漏都有口径），
//    结果回到调用所在节（批不拆），到齐 → 置「待封闭」；
// ⑤ 用户输入 / notice / shell 各自独立成节，且继承最近一次 (turn,step) 归属；
// ⑥ 冻结：封闭节即定型；当前节待定型信号（`assistant/message`）+ 帧边界；追加则撤销冻结；
// ⑦ 迟到交付（两线无序 / 恢复重放）回写原节，不另开新节。

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

/** 工具调用交付（缺省整块参数） */
const call = (
  callId: string,
  args = "{}",
  step = 1,
  fullArgs = true,
): BlockDelivery => ({
  kind: "tool-call",
  turn: 1,
  step,
  callId,
  name: "bash",
  args,
  ...(fullArgs ? { full: true } : {}),
});

/** 工具结果交付 */
const result = (
  callId: string | undefined,
  ok = true,
  step = 1,
): BlockDelivery => ({
  kind: "tool-result",
  turn: 1,
  step,
  ...(callId === undefined ? {} : { callId }),
  ok,
  detail: ok ? "ok" : "boom",
});

const textOf = (
  state: ReturnType<typeof createSections>,
  at = 0,
): string | undefined => itemOf(allSections(state)[at]!, "assistant")?.text;

test("① 两条线交叉只入一次：增量 + 结算整块 / 增量重放", () => {
  const s = applyAll(createSections(), [
    delta(0, "assistant", "你"),
    delta(0, "assistant", "好"),
    full(0, "assistant", "你好"),
    delta(0, "assistant", "你"), // 旧线前缀重放
    delta(0, "assistant", "好"), // 旧线尾部重放
  ]);
  assert.equal(textOf(s), "你好");
  assert.equal(allSections(s).length, 1);
});

test("① 整块先到、更长内容后到：补后缀而非丢弃", () => {
  const withDelta = applyAll(createSections(), [
    full(0, "assistant", "你好"),
    delta(0, "assistant", "世界"),
  ]);
  assert.equal(textOf(withDelta), "你好世界", "整块后到的增量仍入账");

  const withFull = applyAll(createSections(), [
    full(0, "assistant", "abc"),
    full(0, "assistant", "abcdef"),
  ]);
  assert.equal(textOf(withFull), "abcdef", "更长的整块补后缀");

  const empty = applyAll(createSections(), [
    full(0, "assistant", ""),
    delta(0, "assistant", "后到"),
  ]);
  assert.equal(textOf(empty), "后到", "空整块不拦截后续内容");
});

test("① 结算整块先到、增量后到：已覆盖的增量不再入账", () => {
  const s = applyAll(createSections(), [
    full(0, "assistant", "完整正文"),
    delta(0, "assistant", "完整"),
  ]);
  assert.equal(textOf(s), "完整正文");
});

test("① 结算补齐缺失后缀：已交付前缀 + 更长整块 → 只补后缀", () => {
  const s = applyAll(createSections(), [
    delta(0, "assistant", "前半"),
    full(0, "assistant", "前半后半"),
  ]);
  assert.equal(textOf(s), "前半后半");
});

test("① 与已入账不符的整块不回写、不污染账本", () => {
  const s = applyAll(createSections(), [
    delta(0, "assistant", "你好"),
    full(0, "assistant", "您好"),
    delta(0, "assistant", "！"),
  ]);
  assert.equal(textOf(s), "你好！", "既有内容保留，后续增量按既有文本续接");
});

test("① seq 去重：同一事件号重放只入一次", () => {
  const event: BlockDelivery = {
    kind: "tool-result",
    turn: 1,
    step: 1,
    callId: "c1",
    ok: true,
    detail: "ok",
    seq: 42,
  };
  const s = applyAll(createSections(), [call("c1"), event, event]);
  assert.equal(itemOf(allSections(s)[0]!, "tool")?.results?.length, 1);
});

test("② 节内归并：reasoning / assistant 交错不被切断，顺序按首现", () => {
  const s = applyAll(createSections(), [
    delta(0, "reasoning", "r1"),
    delta(1, "assistant", "a1"),
    delta(2, "reasoning", "r2"),
    delta(3, "assistant", "a2"),
  ]);
  assert.deepEqual(
    allSections(s)[0]?.items.map((item) => [item.source, item.text]),
    [
      ["reasoning", "r1r2"],
      ["assistant", "a1a2"],
    ],
  );
});

test("③ 惰性开节：只有 step/start 时无空节；step 变化才切节", () => {
  const empty = applyDelivery(createSections(), {
    kind: "step-start",
    turn: 1,
    step: 1,
    time: 1,
  });
  assert.deepEqual(allSections(empty), []);
  const withText = applyDelivery(empty, delta(0, "assistant", "正文"));
  assert.equal(allSections(withText)[0]?.time, 1, "时间戳留到开节时取用");

  const next = applyAll(withText, [
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
  assert.deepEqual(
    allSections(next).map((section) => section.step),
    [1, 2],
  );
});

test("③ 待开节标记只消费一次：step/start 后连续两块内容仍属同一节", () => {
  const s = applyAll(createSections(), [
    { kind: "step-start", turn: 1, step: 1, time: 1 },
    delta(0, "assistant", "你"),
    delta(1, "reasoning", "（想）"),
    delta(0, "assistant", "好"),
  ]);
  assert.equal(allSections(s).length, 1);
  assert.deepEqual(
    allSections(s)[0]?.items.map((item) => [item.source, item.text]),
    [
      ["assistant", "你好"],
      ["reasoning", "（想）"],
    ],
  );
});

test("③ 重复 / 迟到的 step-start 不切节（持久线重放与两线无序）", () => {
  const repeated = applyAll(createSections(), [
    { kind: "step-start", turn: 1, step: 1, time: 1 },
    delta(0, "assistant", "第一步"),
    { kind: "step-start", turn: 1, step: 1, time: 2 },
    delta(1, "assistant", "接续"),
  ]);
  assert.equal(
    allSections(repeated).length,
    1,
    "同一 (turn,step) 的 step-start 幂等",
  );

  const late = applyAll(createSections(), [
    delta(0, "assistant", "实时先到"),
    { kind: "step-start", turn: 1, step: 1, time: 1 },
  ]);
  assert.equal(allSections(late).length, 1, "迟到 step-start 不另开节");
  assert.equal(textOf(late), "实时先到");
});

test("④ 工具批：结果到齐置待封闭，批内多调用按 callId 配对", () => {
  const s = applyAll(createSections(), [call("c1"), call("c2"), result("c1")]);
  assert.equal(allSections(s).length, 1, "结果未到齐 → 仍是同一节");
  assert.equal(s.awaiting.get("1:1")?.size, 1, "还等 c2");

  const done = applyDelivery(s, result("c2", false));
  assert.equal(done.awaiting.get("1:1")?.size, 0);
  assert.equal(done.pendingOpen, true, "结果到齐 → 待封闭");

  const tool = itemOf(allSections(done)[0]!, "tool");
  assert.deepEqual(
    tool?.calls?.map((entry) => entry.callId),
    ["c1", "c2"],
  );
  assert.deepEqual(
    tool?.results?.map((entry) => [entry.callId, entry.ok]),
    [
      ["c1", true],
      ["c2", false],
    ],
  );

  const next = applyDelivery(done, delta(0, "assistant", "后续正文"));
  assert.equal(allSections(next).length, 2, "下一块内容另起一节");
});

test("④ 工具参数：整块先到 + 增量后到不损坏；分片累计按序拼接", () => {
  const wholeFirst = applyAll(createSections(), [
    call("c1", '{"cmd":"ls"}'),
    call("c1", '{"cmd"', 1, false),
    call("c1", ':"ls"}', 1, false),
  ]);
  assert.equal(wholeFirst.toolArgs.get("c1")?.args, '{"cmd":"ls"}');

  const spread = applyAll(createSections(), [
    call("c2", '{"cmd"', 1, false),
    call("c2", ':"ls"}', 1, false),
    call("c2", ':"ls"}', 1, false), // 重复分片
  ]);
  assert.equal(spread.toolArgs.get("c2")?.args, '{"cmd":"ls"}');
});

test("④ 结果早于调用：调用不再登记待配对", () => {
  const s = applyAll(createSections(), [result("c9"), call("c9")]);
  assert.equal(s.awaiting.get("1:1")?.size ?? 0, 0, "已有结果的调用不再等待");
  assert.deepEqual(
    itemOf(allSections(s)[0]!, "tool")?.results?.map((entry) => entry.callId),
    ["c9"],
  );
});

test("④ 缺 callId 的结果按到达顺序配对", () => {
  const s = applyAll(createSections(), [
    call("c1"),
    call("c2"),
    result(undefined),
  ]);
  assert.deepEqual(
    [...(s.awaiting.get("1:1") ?? [])],
    ["c2"],
    "消费的是第一个待配对项",
  );
  assert.deepEqual(
    itemOf(allSections(s)[0]!, "tool")?.results?.map((entry) => entry.callId),
    ["c1"],
  );
});

test("④ 跨 step 不泄漏：step1 未到齐不影响 step2 的批到齐", () => {
  const s = applyAll(createSections(), [
    call("c1", "{}", 1),
    { kind: "step-start", turn: 1, step: 2 },
    call("c2", "{}", 2),
    result("c2", true, 2),
  ]);
  assert.equal(s.pendingOpen, true, "step2 的批到齐独立判定");
  assert.equal(s.awaiting.get("1:1")?.size, 1, "step1 的待配对项仍留着");
  assert.deepEqual(
    allSections(s).map((section) => section.step),
    [1, 2],
  );
});

test("④ steer 插话落在批中间：结果回到调用所在节（批不拆）", () => {
  const s = applyAll(createSections(), [
    call("c1", "{}", 1),
    { kind: "user", turn: 1, step: 1, text: "插话", queued: "steer" },
    result("c1", true, 1),
  ]);
  const sections = allSections(s);
  assert.deepEqual(
    sections.map((section) => section.items.map((item) => item.source)),
    [["tool"], ["user"]],
    "结果回写到调用所在的工具节，不新开只有结果的节",
  );
  assert.equal(itemOf(sections[0]!, "tool")?.results?.[0]?.callId, "c1");
});

test("④ 中断的 step 不再等批结果（结果仍配进本节）", () => {
  const s = applyAll(createSections(), [
    call("c1", "{}", 1),
    { kind: "interrupted", turn: 1, step: 1 },
  ]);
  assert.equal(s.awaiting.get("1:1")?.size, 0, "中断后不登记待配对");
  assert.equal(s.pendingOpen, false, "中断不置待封闭（结果仍属本节那批）");

  const paired = applyDelivery(s, result("c1", false));
  const sections = allSections(paired);
  assert.equal(sections.length, 1, "结果留在本节");
  assert.equal(itemOf(sections[0]!, "tool")?.results?.[0]?.callId, "c1");
});

test("⑤ 用户输入 / notice / shell 各自独立成节，并继承最近一次归属", () => {
  const s = applyAll(createSections(), [
    { kind: "step-start", turn: 3, step: 2 },
    {
      kind: "text",
      turn: 3,
      step: 2,
      index: 0,
      source: "assistant",
      text: "正文",
    },
    { kind: "notice", text: "提示", tone: "warn" },
    { kind: "shell", text: "$ ls" },
    { kind: "user", turn: 4, step: 1, text: "下一问" },
  ]);
  assert.deepEqual(
    allSections(s).map((section) => [
      section.items.map((item) => item.source),
      section.turn,
      section.step,
    ]),
    [
      [["assistant"], 3, 2],
      [["notice"], 3, 2],
      [["shell"], 3, 2],
      [["user"], 4, 1],
    ],
  );
  assert.equal(allSections(s)[1]?.items[0]?.tone, "warn");
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

  const open = applyDelivery(createSections(), delta(0, "assistant", "正文"));
  assert.equal(freezeAtFrameBoundary(open).current?.frozen, false);

  const closed = applyDelivery(open, {
    kind: "user",
    turn: 1,
    step: 2,
    text: "问",
  });
  assert.equal(closed.sections[0]?.frozen, true);
});

test("⑥ 回合结束：封闭当前节并给该回合最后一个 assistant 节打 final", () => {
  const s = applyAll(createSections(), [
    delta(0, "assistant", "第一步正文"),
    { kind: "step-start", turn: 1, step: 2 },
    {
      kind: "text",
      turn: 1,
      step: 2,
      index: 0,
      source: "assistant",
      text: "总结",
    },
    { kind: "turn-end", turn: 1, step: 2 },
  ]);
  assert.equal(s.current, undefined, "回合结束即封闭");
  assert.deepEqual(
    allSections(s).map((section) => section.final === true),
    [false, true],
    "final 只落在该回合最后一个 assistant 节",
  );
});

test("⑦ 迟到交付回写原节，不另开新节（两线无序 / 恢复重放）", () => {
  const s = applyAll(createSections(), [
    delta(0, "assistant", "第一回合"),
    { kind: "step-start", turn: 2, step: 1 },
    {
      kind: "text",
      turn: 2,
      step: 1,
      index: 0,
      source: "assistant",
      text: "第二回合",
    },
    // 迟到：turn 1 / step 1 的结算整块（比实时增量更长）
    {
      kind: "text",
      turn: 1,
      step: 1,
      index: 0,
      source: "assistant",
      text: "第一回合（补全）",
      full: true,
    },
  ]);
  const sections = allSections(s);
  assert.deepEqual(
    sections.map((section) => [section.turn, section.step]),
    [
      [1, 1],
      [2, 1],
    ],
    "迟到块回写原节，不新增错序节",
  );
  assert.equal(itemOf(sections[0]!, "assistant")?.text, "第一回合（补全）");
  assert.equal(sections[0]?.frozen, false, "回写撤销冻结（派生缓存须失效）");
});
