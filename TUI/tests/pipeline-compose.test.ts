// tests/pipeline-compose.test.ts — §7 组装 整体模块测试（一次只测这一个阶段）
//
// 模块口径：`rowsToFrame`（Row→FrameRow 段映射）与 `renderPane` 的输出形态
// （rows.session/turn 分别以各自宽铺平、frame = 两 pane 行按序并置）。
// 不深究 sub-stage 内部（那些各有专属模块测试）；本文件只验证 §7 的组装契约。

import { test } from "node:test";
import assert from "node:assert/strict";

import { rowsToFrame, renderPane } from "../src/app/layout/pipeline/compose.ts";
import { parse } from "../src/app/layout/pipeline/parse.ts";
import type {
  Row,
  Section,
  EventGroup,
} from "../src/app/layout/pipeline/ir.ts";

function sec(partial: Partial<Section> & { id: string }): Section {
  return { turn: 1, step: 1, seqs: [], ...partial };
}

function groups(ses: Section[]): EventGroup[] {
  return ses.map((s) => ({ provenance: s, blocks: parse(s) }));
}

test("rowsToFrame：Row.segments → FrameRow.segments 1:1 保序、不含语义字段", () => {
  const segs = [{ text: "ab" }, { text: "cd" }];
  const rows: Row[] = [{ segments: segs as never, indent: 2 }];
  const frames = rowsToFrame(rows);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.segments.length, 2);
  assert.equal(frames[0]!.segments[0]!.text, "ab");
  assert.equal(frames[0]!.segments[1]!.text, "cd");
});

test("renderPane：终态正文 → 会话区行；frame = session 行 + turn 行并置", () => {
  const final = sec({
    id: "1:1:1",
    final: true,
    body: { source: "assistant", text: "答" },
  });
  const thought = sec({ id: "1:1:2", reasoning: "想" });
  const r = renderPane(groups([final, thought]), {
    sessionWidth: 30,
    turnWidth: 30,
    view: { declaredSteps: [] },
  });
  assert.ok((r.rows.session ?? []).length >= 1, "会话区有行（正文）");
  assert.ok((r.rows.turn ?? []).length >= 1, "回合区有行（思考）");
  // frame = session 行 + turn 行按序并置（in-order concatenation）
  const expect = (r.rows.session ?? []).length + (r.rows.turn ?? []).length;
  assert.equal(r.frame.length, expect, "frame 行数 = 两 pane 行数之和");
});

test("renderPane：各行段文本可从行内读取（终态正文可见）", () => {
  const final = sec({
    id: "1:1:1",
    final: true,
    body: { source: "assistant", text: "ok" },
  });
  const r = renderPane(groups([final]), {
    sessionWidth: 20,
    view: { declaredSteps: [] },
  });
  const joined = (r.rows.session ?? [])
    .map((x) => x.segments.map((s) => s.text).join(""))
    .join("");
  assert.ok(joined.includes("ok"), "会话区行含正文");
});
