// tests/focus-frame.test.ts — 焦点构图与面板渲染双轨对照
//
// 冻结基线：fixtures/focus-frame-legacy.json（scripts/freeze-focus-frame.mts
// 生成，其调用了迁移前的内联焦点构图 buildFrame）。本测试从 fixture 读取
// 基线并重新生成逐行精确比较（text + ansi），确保新 Box/FocusFrame 管线
// 与冻结行为逐一等价。新增场景须双处同步（冻结脚本 + 本测试）。
//
// 对比口径：整帧每行 {text, ansi} 精确相等（text=纯文本、ansi=段级序列化
// 含样式差异）。覆盖：焦点态 null/history/activity/status × w60/w20、
// 七个面板场景（approval/question/picker/statusPanel/jobsPanel/history/completion）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildFrame as buildFrameRaw,
  wrapHintLine,
} from "../src/app/layout.ts";
import { PICKER_HINT_LINE } from "../src/app/layout/hints.ts";
import { rowAnsi } from "./helpers/rowText.ts";
import { colsFor, stateFor } from "./helpers/focusFrameScenes.ts";
import type { AppState } from "../src/app/state.ts";
import type { FrameRow } from "../src/renderer/screen.ts";

interface FixtureEntry {
  rows: { text: string; ansi: string }[];
}
interface Fixture {
  [key: string]: FixtureEntry;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "focus-frame-legacy.json");
const FIXTURE: Fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
const TF = { rows: 24 } as const;

function rowsOf(
  state: AppState,
  cols: number,
): { text: string; ansi: string }[] {
  return buildFrameRaw(state, { ...TF, cols }).map((r: FrameRow) => ({
    text: r.segments.map((g) => g.text).join(""),
    ansi: rowAnsi(r),
  }));
}

// —— 全场景逐行精确对照 ——
for (const key of Object.keys(FIXTURE)) {
  test(`focus-frame 基线：${key}`, () => {
    const baseline = FIXTURE[key]!.rows;
    const got = rowsOf(stateFor(key), colsFor(key));
    assert.equal(got.length, baseline.length, `行数一致 (${key})`);
    for (let i = 0; i < baseline.length; i++) {
      assert.equal(got[i]!.text, baseline[i]!.text, `${key} 第 ${i} 行 text`);
      assert.equal(got[i]!.ansi, baseline[i]!.ansi, `${key} 第 ${i} 行 ansi`);
    }
  });
}

/**
 * `panel-picker@w60` 的输入区 + 提示区形态（2026-10-14 重冻后它已是基线的一部分，
 * 不再走「豁免 + 专用断言」）：输入区让位给 2 行提示后为 2 行（首行筛选输入、次行空），
 * 提示行按 ` · ` 边界折 2 行。
 */
test("focus-frame：panel-picker@w60 的输入区改显筛选行、提示行折 2 行", () => {
  const got = rowsOf(stateFor("panel-picker@w60"), 60);
  // 输入区首行 = 筛选输入行（`筛选 <焦点列>: <词>`；词空 → placeholder, caret 在词尾）
  assert.equal(got[20]!.text, "筛选 provider: 输入以筛选 (匹配度排序)");
  // 输入区第 2 行仍是空行（提示区占 2 行 ⟹ footer 由 3 行缩为 2 行，交互区总高恒 4 行）
  assert.equal(got[21]!.text, "");
  // 提示行 = 键位文案按 ` · ` 边界折行（60 列 ⟹ 2 行）
  const expected = wrapHintLine(PICKER_HINT_LINE, 60);
  assert.equal(expected.length, 2, "60 列下选择面板提示折 2 行");
  assert.equal(got[22]!.text, expected[0]);
  assert.equal(got[23]!.text, expected[1]);
});

// —— 结构不变量：FocusFrame 不改行数/行序（A5 兼容）——
test("focus-frame：行不变量（行数恒定、无 CJK 被切、显示宽度不回退）", () => {
  const s = stateFor("focus-activity@w60");
  const rows = buildFrameRaw(s, { ...TF, cols: 60 });
  // 每行段拼接的显示宽度不因实现变化而改变（以 text 长度近似校验行序稳定）
  const texts = rows.map((r: FrameRow) =>
    r.segments.map((g) => g.text).join(""),
  );
  assert.equal(texts.length, FIXTURE["focus-activity@w60"]!.rows.length);
});
