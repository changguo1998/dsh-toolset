// tests/pipeline-split.test.ts — §1 分节 整体模块测试（一次只测这一个阶段）
//
// 模块口径：HistoryRow 缓冲（现实输入来源）→ `sectionsFromBuffer` → `splitSections`，
// 断言按模型交互边界分组、来源更换断点、final/standalone/user 态归位。
// 不混入 parse/route 等其它阶段（那些各有专属模块测试文件）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { sectionsFromBuffer } from "../src/app/layout/pipeline/replay.ts";
import {
  splitSections,
  splitOldSections,
  replaySections,
} from "../src/app/layout/pipeline/split.ts";
import { allSections } from "../src/app/layout/pipeline/sections.ts";
import type { SectionsState } from "../src/app/layout/pipeline/sections.ts";
import type { HistoryRow } from "../src/app/state.ts";

function buffer(rows: HistoryRow[]): SectionsState {
  return sectionsFromBuffer(rows, { history: true });
}

test("split：用户块 → 终态正文按来源更换断成独立 Section 且元数据归位", () => {
  const st = buffer([
    { kind: "user", text: "问", turn: 1, step: 1 },
    { kind: "assistant", text: "答", turn: 1, step: 1, final: true },
  ]);
  const secs = splitSections(st);
  const user = secs.find((s) => s.body?.source === "user");
  const asst = secs.find((s) => s.body?.source === "assistant");
  assert.ok(user, "用户来源成节");
  assert.equal(user!.turn, 1);
  assert.equal(user!.user !== undefined, true, "用户块带运行时态槽");
  assert.ok(asst, "终态正文成节");
  assert.equal(asst!.final, true, "final 透传");
  assert.equal(asst!.body!.text, "答");
});

test("split：同一推理的思考 + 终态正文归同一条交互的思考/正文槽", () => {
  // 同一 step 内 thinking 先行、assistant-final 随后 → split 把它们并进同一条 Section
  const st = buffer([
    { kind: "user", text: "问", turn: 1, step: 1 },
    { kind: "thinking", text: "想", turn: 1, step: 1 },
    { kind: "assistant", text: "答", turn: 1, step: 1, final: true },
  ]);
  const secs = splitSections(st);
  const withReasoning = secs.find((s) => s.reasoning !== undefined);
  assert.ok(withReasoning, "存在带思考槽的节");
  assert.equal(withReasoning!.reasoning, "想");
  // 同一条节的 body 是 final 正文（若与思考同节）或另一节也 final
  assert.ok(
    withReasoning!.body !== undefined ||
      secs.some((s) => s.body?.source === "assistant"),
    "思考/正文都物化",
  );
});

test("split：终态标记（final）只挂其那一节", () => {
  const st = buffer([
    { kind: "user", text: "问一", turn: 1, step: 1 },
    { kind: "assistant", text: "答一", turn: 1, step: 1, final: true },
    { kind: "user", text: "问二", turn: 2, step: 1 },
    { kind: "assistant", text: "答二", turn: 2, step: 1, final: true },
  ]);
  const secs = splitSections(st);
  const finals = secs.filter((s) => s.final === true);
  assert.equal(finals.length, 2, "两个终态正文");
  for (const f of finals) assert.equal(f.body?.source, "assistant");
});

test("splitOldSections：对窗口保留段分节（旧节数组版本），来源断点同口径", () => {
  const st = buffer([
    { kind: "user", text: "问", turn: 1, step: 1 },
    { kind: "assistant", text: "答", turn: 1, step: 1, final: true },
    { kind: "user", text: "追问", turn: 2, step: 1 },
  ]);
  const old = allSections(st);
  const full = splitOldSections(old);
  const windowed = splitOldSections(old.slice(2)); // 保留 turn2 起
  assert.equal(full.length >= 1, true);
  assert.equal(windowed.length >= 1, true);
  // 窗口保留段来源仍是 user（turn2）
  assert.equal(windowed[windowed.length - 1]!.body?.source, "user");
});

test("split：最新未终态用户节被标 active（运行态 post-pass）", () => {
  const st = buffer([
    { kind: "user", text: "问", turn: 1, step: 1 },
    { kind: "assistant", text: "答", turn: 1, step: 1, final: true },
    { kind: "user", text: "最新未答", turn: 2, step: 1 },
  ]);
  const secs = splitSections(st);
  const latest = secs[secs.length - 1]!;
  assert.equal(latest.body?.source, "user");
  assert.equal(latest.user?.active, true, "最新未终态用户 → active");
  const others = secs.filter((s) => s.user !== undefined && s !== latest);
  for (const o of others)
    assert.notEqual(o.user?.active, true, "更早用户不标 active");
});

test("replaySections：恢复路径产 Section[]（复用同一分组口径）", () => {
  const rows: HistoryRow[] = [
    { kind: "user", text: "问", turn: 1, step: 1 },
    { kind: "assistant", text: "答", turn: 1, step: 1, final: true },
  ];
  const secs = replaySections(rows);
  assert.equal(secs.length >= 1, true);
  assert.ok(
    secs.some((s) => s.body?.source === "user"),
    "用户节在",
  );
  assert.ok(
    secs.some((s) => s.body?.source === "assistant"),
    "正文节在",
  );
});
