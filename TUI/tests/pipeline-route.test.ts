// tests/pipeline-route.test.ts — §3 分流 整体模块测试（一次只测这一个阶段）
//
// 模块口径：Section[] → parse → EventGroup[] → `route` → {session, turn},
// 断言 pane 归属、间隔 Gap、step 头内容驱动、回合分隔、工具批组合、档位过滤、
// 遮蔽清单。不混入 split/measure 等阶段。

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/app/layout/pipeline/parse.ts";
import { route } from "../src/app/layout/pipeline/route.ts";
import { shadowedBlockIds } from "../src/app/layout/pipeline/route.ts";
import type {
  EventGroup,
  PaneItem,
  Section,
} from "../src/app/layout/pipeline/ir.ts";

function sec(partial: Partial<Section> & { id: string }): Section {
  return { turn: 1, step: 1, seqs: [], ...partial };
}

function groups(ses: Section[]): EventGroup[] {
  return ses.map((s) => ({
    provenance: s,
    blocks: parse(s),
    ...(s.calls !== undefined ? { calls: s.calls } : {}),
    ...(s.results !== undefined ? { results: s.results } : {}),
  }));
}

const rt = (ses: Section[], opts: Parameters<typeof route>[1] = {}) =>
  route(groups(ses), opts);

test("route：用户块 + 终态正文 → session；无回合内容", () => {
  const { session, turn } = rt([
    sec({ id: "1:1:0", user: {}, body: { source: "user", text: "问" } }),
    sec({
      id: "1:1:1",
      final: true,
      body: { source: "assistant", text: "答" },
    }),
  ]);
  const kinds = session.map((i) =>
    i.kind === "paragraph" ? i.source : i.kind,
  );
  assert.ok(kinds.includes("user"), "用户块进会话区");
  assert.ok(kinds.includes("assistant"), "终态正文进会话区");
  assert.equal(turn.length, 0, "无 `turn` 内容");
});

test("route：思考 → turn，且 content-driven 出 step 头（只对已声明 step）", () => {
  const { turn } = rt([sec({ id: "1:1:0", reasoning: "想" })], {
    declaredSteps: ["1:1"],
  });
  assert.equal(turn[0]!.kind, "step-header", "step 头先行");
  const think = turn.find((i) => i.kind === "paragraph");
  assert.equal(
    (think as Extract<PaneItem, { kind: "paragraph" }>).source,
    "reasoning",
  );
  // 未声明 step → 不产头
  const { turn: t2 } = rt([sec({ id: "1:1:0", reasoning: "想" })]);
  assert.ok(!t2.some((i) => i.kind === "step-header"), "未声明不产头");
});

test("route：思考→非终态正文 互切插显式 Gap", () => {
  const { turn } = rt(
    [
      sec({ id: "1:1:0", reasoning: "想" }),
      sec({ id: "1:1:1", body: { source: "assistant", text: "过程" } }), // 非 final → turn
    ],
    { declaredSteps: ["1:1"] },
  );
  const kinds = turn.map((i) => i.kind);
  assert.ok(kinds.includes("gap"), "think↔reply 间插 Gap");
  assert.equal(
    turn.filter((i) => i.kind === "gap").length,
    1,
    "恰好一个间隔空行",
  );
});

test("route：turn-times → session 出回合分隔（首条内容前）", () => {
  const { session } = rt(
    [sec({ id: "1:1:0", user: {}, body: { source: "user", text: "问" } })],
    { turnTimes: new Map<string, number>([["1", 1_700_000_000_000]]) },
  );
  assert.equal(session[0]!.kind, "turn-header", "回合分隔在会话区头部");
});

test("route：有调用的工具批组合进 turn（role source）", () => {
  const s = sec({
    id: "1:1:0",
    calls: [{ callId: "c1", name: "bash", args: "{}" }],
    results: [{ callId: "c1", ok: true, detail: "out" }],
  });
  const { turn } = rt([s]);
  assert.ok(
    turn.some((i) => i.kind === "tool-batch"),
    "工具批进回合区",
  );
});

test("route：档位过滤（/verbose tool off 去工具批；恒显保留）", () => {
  const s = sec({
    id: "1:1:0",
    calls: [{ callId: "c1", name: "bash", args: "{}" }],
  });
  const on = rt([s], { activityShow: { tool: true } });
  const off = rt([s], { activityShow: { tool: false } });
  assert.ok(
    on.turn.some((i) => i.kind === "tool-batch"),
    "tool 显 时在",
  );
  assert.ok(!off.turn.some((i) => i.kind === "tool-batch"), "tool 隐 时不在");
});

test("route：遮蔽事件号 → 块 id 收集进清单", () => {
  const s = sec({
    id: "1:1:0",
    seqs: [9],
    reasoning: "想",
  });
  const groups1 = groups([s]);
  const shadowed = shadowedBlockIds(groups1, new Set([9]));
  assert.ok(shadowed.size > 0, "遮蔽命中产生块 id");
});
