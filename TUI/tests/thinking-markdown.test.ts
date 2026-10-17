// tests/thinking-markdown.test.ts — 思考内容排版（BACKLOG「思考内容也进行排版（块级元素 +
//   代码块；行内 markdown 留后续）」）：
//   - 思考行与正文同口径渲染 markdown 子集：块级元素（标题 / 无序与有序列表 / 引用 /
//     分隔线 / 任务列表）+ 行内（粗体 / 行内代码，随复用 wrapAssistantLine 一并生效）；
//   - 围栏代码块走正文 / 思考共用构建器（fence 开关行隐藏、语言标记行斜体、行号 + 右缩进、
//     灰底补齐）；未闭栅（流式）后续行按代码底色直出；
//   - 思考特有形制不变：紫 ┃ 前缀、空行跳过、档位过滤、紧凑压单行、与正文互切 1 行间隔。

import { test } from "node:test";
import assert from "node:assert/strict";

import { rowText } from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import type { BuildBoxOptions } from "../src/app/layout/build-box.ts";
import type { HistoryRow } from "../src/app/state.ts";
import { segStyle } from "../src/renderer/screen.ts";
import { THEMES } from "../src/renderer/theme.ts";
import { rowAnsi } from "./helpers/rowText.ts";

const W = 40;
const L = (text: string, kind: HistoryRow["kind"]): HistoryRow => ({
  text,
  kind,
});

/** 活动区渲染结果（FrameRow 原样 + 纯文本行），两 pane 同宽 */
function act(
  buf: HistoryRow[],
  opts: BuildBoxOptions = {},
): { rows: ReturnType<typeof buildContentRows>["activity"]; text: string[] } {
  const rows = buildContentRows(buf, opts, W, W).activity;
  return { rows, text: rows.map(rowText) };
}

/** 段样式（首段 = 左缘前缀段） */
const BAR_ANSI = segStyle(
  { text: "┃", style: { fg: "brightMagenta" } },
  THEMES.dark,
);

test("思考行块级元素与正文同规格（标题 / 列表 / 引用 / 分隔线 / 任务列表）", () => {
  const { text } = act([
    L("# 一级标题", "thinking"),
    L("- 项一", "thinking"),
    L("1. 编号一", "thinking"),
    L("> 引用", "thinking"),
    L("- [x] 已完成", "thinking"),
    L("---", "thinking"),
  ]);
  const joined = text.join("\n");
  assert.ok(joined.includes("一级标题"), `标题内容保留: ${joined}`);
  assert.ok(!joined.includes("# 一级标题"), "# 记号被消费");
  assert.ok(joined.includes("• 项一"), "- 统一显示为 •");
  assert.ok(joined.includes("1. 编号一"), "有序列表保留数字前缀");
  assert.ok(joined.includes("> 引用"), "引用保留 > 前缀");
  assert.ok(joined.includes("[x] 已完成"), "任务列表显示 [x]");
  assert.ok(
    /┃─{10,}/.test(text[5] ?? ""),
    `分隔线横线铺满正文宽: ${JSON.stringify(text[5])}`,
  );
  // 每行左缘仍是紫 ┃ 前缀（与正文蓝竖线同形制）
  for (const line of text) {
    assert.ok(line.startsWith("┃"), `行首 ┃: ${JSON.stringify(line)}`);
  }
  const { rows } = act([L("# 标题", "thinking")]);
  assert.ok(
    rowAnsi(rows[0]!).startsWith(BAR_ANSI),
    `前缀紫（brightMagenta，与正文蓝竖线同形制）: ${rowAnsi(rows[0]!)}`,
  );
});

test("思考行行内 markdown 与正文同口径（粗体 / 行内代码）", () => {
  const { rows, text } = act([L("**粗** 与 `code` 并列", "thinking")]);
  assert.ok(
    text[0]!.includes("粗 与 code 并列"),
    `行内记号被消费: ${JSON.stringify(text[0])}`,
  );
  const ansi = rowAnsi(rows[0]!);
  assert.ok(ansi.includes("\x1b[1m"), `粗体 SGR: ${ansi}`);
  assert.ok(/\x1b\[48;2;\d+;\d+;\d+m/.test(ansi), `行内代码灰底: ${ansi}`);
});

test("思考内长列表项折行：续行悬挂缩进对齐正文、不重复前缀", () => {
  const { rows, text } = act([L("- " + "字".repeat(60), "thinking")]);
  assert.ok(rows.length >= 3, `列表项折出多行（实际 ${rows.length}）`);
  assert.ok(
    (text[0] ?? "").startsWith("┃• "),
    `首行 ┃ + • 前缀: ${JSON.stringify(text[0])}`,
  );
  for (const line of text.slice(1)) {
    assert.ok(
      line.startsWith("┃  ") && !line.startsWith("┃• "),
      `续行悬挂缩进 2 列且不重复子弹: ${JSON.stringify(line)}`,
    );
  }
});

test("思考内围栏代码块：fence 隐藏 / 语言行斜体 / 行号 + 灰底补齐", () => {
  const { rows, text } = act([
    L("```ts", "thinking"),
    L("const a = 1;", "thinking"),
    L("const b = 2;", "thinking"),
    L("```", "thinking"),
    L("**fence 外** 仍解析", "thinking"),
  ]);
  const joined = text.join("\n");
  assert.ok(!joined.includes("```"), `fence 开关行不显示: ${joined}`);
  assert.ok(
    text.some((line) => /┃\s*ts/.test(line)),
    `语言标记行: ${joined}`,
  );
  assert.ok(
    text.some((line) => line.includes(" 1 const a = 1;")),
    `首行行号 1: ${joined}`,
  );
  assert.ok(
    text.some((line) => line.includes(" 2 const b = 2;")),
    `第二行行号 2: ${joined}`,
  );
  assert.ok(
    !joined.includes("**fence 外**"),
    `fence 外行内 markdown 照常解析: ${joined}`,
  );
  const codeRow = rows.find((r) => rowText(r).includes("const a = 1;"));
  assert.ok(codeRow !== undefined, "代码行在活动区");
  assert.ok(
    /\x1b\[48;2;\d+;\d+;\d+m/.test(rowAnsi(codeRow!)),
    `代码行灰底: ${rowAnsi(codeRow!)}`,
  );
  const langRow = rows.find((r) => rowText(r).includes("ts"));
  assert.ok(langRow !== undefined, "语言标记行在活动区");
  assert.ok(
    /\x1b\[3m/.test(rowAnsi(langRow!)),
    `语言标记行斜体: ${rowAnsi(langRow!)}`,
  );
});

test("思考内未闭栅（流式）：围栏内行仍按代码块出行、fence 记号不显示", () => {
  const { rows, text } = act([
    L("```", "thinking"),
    L("partial **line**", "thinking"),
  ]);
  assert.ok(!text.join("\n").includes("```"), "fence 记号不显示");
  const row = rows.find((r) => rowText(r).includes("partial"));
  assert.ok(row !== undefined, "围栏内行在活动区");
  assert.ok(
    rowText(row!).includes(" 1 partial"),
    `未闭栅同样带行号（与正文同口径）: ${rowText(row!)}`,
  );
  assert.ok(
    rowText(row!).includes("**line**"),
    `围栏内不解析行内 markdown: ${rowText(row!)}`,
  );
  assert.ok(
    /\x1b\[48;2;\d+;\d+;\d+m/.test(rowAnsi(row!)),
    `代码底色: ${rowAnsi(row!)}`,
  );
});

test("回归：档位过滤 / 紧凑压单行 / 思考 ↔ 正文 1 行间隔", () => {
  // tool 档：思考整类不显示（markdown 化不影响档位语义）
  const tool = act([L("思考", "thinking"), L("正文", "assistant")], {
    activityLevel: "tool",
  });
  assert.ok(
    !tool.text.join("\n").includes("思考"),
    `tool 档去思考: ${tool.text.join("\n")}`,
  );
  // 紧凑（/collapse）：含 markdown 记号的思考仍压 1 行、不解析（原样 + 截断）
  const compact = act([L("# 标题一", "thinking"), L("- 列表一", "thinking")], {
    activityCompact: true,
  });
  assert.equal(
    compact.rows.length,
    2,
    `紧凑每条目 1 行（实际 ${compact.rows.length}）`,
  );
  assert.ok(
    compact.text[0]!.includes("# 标题一"),
    `紧凑不解析 markdown: ${JSON.stringify(compact.text[0])}`,
  );
  // 类型间隔：思考 → 非 final 正文 之间恰插 1 行空行（隐藏 fence 行也算思考类）
  const gap = act([L("思考", "thinking"), L("正文", "assistant")]);
  assert.deepEqual(
    gap.text.map((line) => line.trim() === ""),
    [false, true, false],
    `间隔空行: ${JSON.stringify(gap.text)}`,
  );
  const fenceGap = act([
    L("```", "thinking"),
    L("code", "thinking"),
    L("```", "thinking"),
    L("正文", "assistant"),
  ]);
  assert.deepEqual(
    fenceGap.text.map((line) => line.trim() === ""),
    [false, true, false],
    `代码块（开关行隐藏、闭栅行被收录消费）后仍有 1 行间隔: ${JSON.stringify(fenceGap.text)}`,
  );
});
