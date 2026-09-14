// tests/question-wrap.test.ts — 问答面板选项在活动窗内折行（纯函数级）
//
// 回归：选项文本超出面板可用宽时不得截断/溢出活动窗口，应 soft-wrap 为多行，
// 光标/选中标记只挂在选项首行，续行缩进与选项文本起点对齐、为普通文本。

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderQuestionPanel } from "../src/app/components/QuestionPrompt.ts";
import type { QuestionPanelState } from "../src/app/state.ts";

function panel(
  options: { label: string; description?: string }[],
): QuestionPanelState {
  return {
    id: "q",
    items: [
      {
        id: "qa",
        question: "选择部署方式",
        options,
        multiSelect: false,
        optionIndex: 0,
        selected: [],
        custom: "",
      },
    ],
    itemIndex: 0,
  };
}

/** 近似显示宽度（CJK/全角=2，其余=1），与面板换行口径一致 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x20000 && cp <= 0x2fffd)
        ? 2
        : 1;
  }
  return w;
}

test("问答面板：长选项按面板宽折行，续行对齐缩进且仅首行带光标", () => {
  const longLabel =
    "这是一个非常长的选项标签，用来验证它在活动窗口内能够正确折行而不是被截断溢出右边框";
  const width = 60;
  const rows = renderQuestionPanel(
    panel([{ label: longLabel }]),
    12,
    width,
    "dark",
  );
  const plain = rows.map((r) => r.text.replace(/\x1b\[[0-9;]*m/g, ""));
  // 选项首行带光标标记，续行紧跟其后（同一选项跨多行）
  const first = plain.findIndex((l) =>
    l.includes(">  " + longLabel.slice(0, 8)),
  );
  assert.ok(first >= 0, "选项首行（光标行）存在: " + JSON.stringify(plain));
  // 选项整体文本都在面板中出现（未被截断），且以多行呈现
  assert.ok(
    plain.some((l) => l.includes(longLabel.slice(-10))),
    "长选项尾部内容出现在面板内（已折行不截断）: " + JSON.stringify(plain),
  );
  // 续行缩进与选项文本起点对齐（` >* ` 前缀宽=4），且为普通文本（无光标标记）
  const cont = plain.find((l) => l.includes(longLabel.slice(-10)));
  assert.ok(
    cont!.startsWith("    "),
    "续行带 4 空格缩进: " + JSON.stringify(cont),
  );
  // 每行显示宽度不超过面板可用宽（不溢出活动窗口右缘）
  const avail = width - 4;
  for (const l of plain) {
    assert.ok(
      l === "" || displayWidth(l) <= avail,
      "行宽超出面板可用宽: " + JSON.stringify(l),
    );
  }
  // 仅选项首行带光标
  const cursorRows = plain.filter((l) => l.includes(">"));
  assert.equal(
    cursorRows.length,
    1,
    "仅选项首行带光标: " + JSON.stringify(plain),
  );
});

test("问答面板：短选项保持单行不折行", () => {
  const rows = renderQuestionPanel(panel([{ label: "生产" }]), 8, 60, "dark");
  const plain = rows.map((r) => r.text.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(
    plain.some((l) => l.includes(">  生产")),
    "短选项单行: " + JSON.stringify(plain),
  );
});

test("问答面板：带 description 的长选项折行后 desc 也完整呈现", () => {
  const rows = renderQuestionPanel(
    panel([{ label: "aaa", description: "bbbb" + "仓".repeat(40) }]),
    14,
    60,
    "dark",
  );
  const plain = rows.map((r) => r.text.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(
    plain.some((l) => l.includes("仓".repeat(4))),
    "description 折行后仍完整呈现: " + JSON.stringify(plain.slice(0, 6)),
  );
});

test("问答面板：长题干按面板宽折行，续行 1 空格缩进与正文对齐", () => {
  const longQ =
    "这是一个非常长的题干文本，用于验证它在活动窗口内同样需要正确折行显示而不是单行溢出被截断";
  const width = 60;
  const item = {
    id: "qa",
    question: longQ,
    header: "部署",
    options: [{ label: "生产" }],
    multiSelect: false,
    optionIndex: 0,
    selected: [],
    custom: "",
  };
  const rows = renderQuestionPanel(
    { id: "q", items: [item], itemIndex: 0 },
    12,
    width,
    "dark",
  );
  const plain = rows.map((r) => r.text.replace(/\x1b\[[0-9;]*m/g, ""));
  // 题干尾部内容出现在面板内（未截断）
  assert.ok(
    plain.some((l) => l.includes(longQ.slice(-10))),
    "长题干尾部完整呈现（已折行）: " + JSON.stringify(plain.slice(0, 4)),
  );
  // 题干首行带 header 前缀，续行以 1 空格缩进与正文起点对齐
  const first = plain.find((l) => l.includes("部署：" + longQ.slice(0, 6)));
  assert.ok(
    first,
    "题干首行含 header 前缀: " + JSON.stringify(plain.slice(0, 4)),
  );
  const cont = plain.find((l) => l.includes(longQ.slice(-10)));
  assert.ok(
    cont!.startsWith(" "),
    "题干续行为 1 空格缩进: " + JSON.stringify(cont),
  );
  // 题干折行不影响选项/光标渲染
  assert.ok(
    plain.some((l) => l.includes(">  生产")),
    "选项仍在: " + JSON.stringify(plain),
  );
  const avail = width - 4;
  for (const l of plain) {
    assert.ok(
      l === "" || displayWidth(l) <= avail,
      "行宽超出面板可用宽: " + JSON.stringify(l),
    );
  }
});
