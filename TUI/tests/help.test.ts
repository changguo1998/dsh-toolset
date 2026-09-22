// tests/help.test.ts — /help 双列排版（无边框表格）纯函数单测
//
// 覆盖：命令列定宽对齐（封顶 HELP_CMD_MAX）、超宽命令描述另起一行对齐
// 描述列、描述列固定起点、每行悬垂缩进 = 描述列起点（渲染层折行时续行
// 停靠该列，不穿回第一列）、CJK 补白按显示列计算。
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayWidth } from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import type { Buffer } from "../src/app/state.ts";
import {
  helpTableLines,
  HELP_MARGIN,
  HELP_GAP,
  HELP_CMD_MAX,
} from "../src/app/layout/help.ts";

const ROWS = [
  { cmd: "/help", desc: "显示本帮助" },
  {
    cmd: "/jobs",
    desc: "后台任务面板（只读列表；↑/↓ 选择、PgUp/PgDn 翻页、Enter 取消、Esc 关闭）",
  },
  { cmd: "/copy", desc: "复制最后一条模型回复" },
] as const;

/** 期望的命令列前缀（缩进 + 命令 + 显示宽补白 + 间距） */
function expectedPrefix(
  rows: readonly { cmd: string }[],
  i: number,
  col1: number,
): string {
  return (
    " ".repeat(HELP_MARGIN) +
    rows[i]!.cmd +
    " ".repeat(col1 - displayWidth(rows[i]!.cmd)) +
    " ".repeat(HELP_GAP)
  );
}

test("命令列定宽：不同长度命令的描述起点同列，悬垂缩进 = 描述列起点", () => {
  const lines = helpTableLines(ROWS);
  const col1 = Math.max(...ROWS.map((r) => displayWidth(r.cmd)));
  const descIndent = HELP_MARGIN + col1 + HELP_GAP;
  assert.equal(lines[0]!.hanging, descIndent, "首行悬垂缩进 = 描述列起点");
  for (let i = 0; i < ROWS.length; i++) {
    const { text, hanging } = lines[i]!;
    assert.equal(hanging, descIndent, "各行悬垂缩进一致");
    const prefix = expectedPrefix(ROWS, i, col1);
    assert.ok(
      text.startsWith(prefix),
      `命令列前缀对齐: ${JSON.stringify(text)}`,
    );
    assert.equal(
      text.slice(prefix.length),
      ROWS[i]!.desc,
      "前缀之后紧跟描述（首列定宽后描述起点同列）",
    );
  }
});

test("CJK 补白按显示列：命令含 CJK 时仍对齐", () => {
  const rows = [
    { cmd: "/预设 <n>", desc: "权限预设" },
    { cmd: "/a", desc: "x" },
  ] as const;
  const lines = helpTableLines(rows);
  const col1 = Math.max(displayWidth("/预设 <n>"), displayWidth("/a"));
  assert.ok(col1 <= HELP_CMD_MAX, "本例命令均未超上限，验证纯补白对齐");
  // 悬垂缩进一致；短命令按显示宽补白到同列
  assert.equal(lines[0]!.hanging, lines[1]!.hanging);
  const p0 = expectedPrefix(rows, 0, col1);
  assert.ok(lines[0]!.text.startsWith(p0));
  assert.equal(
    lines[0]!.text.slice(p0.length),
    "权限预设",
    "CJK 命令列补白后描述起点正确",
  );
  const p1 = expectedPrefix(rows, 1, col1);
  assert.ok(lines[1]!.text.startsWith(p1), "短命令按显示宽补白");
});

test("命令超宽（> HELP_CMD_MAX）：命令独占一行、描述另起一行缩进到描述列起点", () => {
  const rows = [
    {
      cmd: "/provider、/effort (/thinking)",
      desc: "无参直达 /model 面板并定位到 provider / effort 列",
    },
    { cmd: "/jobs", desc: "后台任务面板" },
  ] as const;
  const lines = helpTableLines(rows);
  const descIndent = HELP_MARGIN + HELP_CMD_MAX + HELP_GAP;
  for (const l of lines)
    assert.equal(l.hanging, descIndent, "列宽封顶后各行悬垂缩进一致");
  assert.equal(lines.length, 3, "超宽命令拆出两行 + 普通命令一行");
  assert.equal(
    lines[0]!.text,
    " ".repeat(HELP_MARGIN) + rows[0]!.cmd,
    "命令独占一行",
  );
  assert.equal(
    lines[1]!.text,
    " ".repeat(descIndent) + rows[0]!.desc,
    "描述另起一行且缩进 = 描述列起点（第二列）",
  );
  const short = lines[2]!;
  assert.ok(!short.text.includes("\n"), "未超宽命令保持单物理行");
  const prefix = expectedPrefix(rows, 1, HELP_CMD_MAX);
  assert.ok(short.text.startsWith(prefix), "未超宽命令仍按封顶列宽补白");
  assert.equal(short.text.slice(prefix.length), rows[1]!.desc);
});

test("全短命令列表：列宽回落最长命令，不触发换行（HELP_CMD_MAX 仅为上限）", () => {
  const rows = [
    { cmd: "/quit", desc: "退出" },
    { cmd: "/copy", desc: "复制最后一条模型回复" },
  ] as const;
  const lines = helpTableLines(rows);
  const col1 = Math.max(...rows.map((r) => displayWidth(r.cmd)));
  assert.ok(col1 < HELP_CMD_MAX, "本组命令均短于上限");
  assert.equal(lines[0]!.hanging, HELP_MARGIN + col1 + HELP_GAP);
  for (const l of lines) assert.ok(!l.text.includes("\n"), "短命令无换行");
});

test("行内不再有 \n（未超宽行）：每行单物理行，折行统一由渲染层按 hanging 处理", () => {
  for (const { text } of helpTableLines(ROWS)) {
    assert.ok(!text.includes("\n"), "每条 help 行应为单一物理行");
  }
});

test("渲染层折行：help notice 续行停靠描述列（不穿回第一列）", () => {
  const lines = helpTableLines(ROWS);
  const buffer: Buffer = [
    { kind: "notice", text: "本地命令：" },
    ...lines.map((l) => ({
      kind: "notice" as const,
      text: l.text,
      hanging: l.hanging,
    })),
  ];
  // 窄活动 pane（40 列）强制 /jobs 描述折行
  const { activity } = buildContentRows(buffer, { themeId: "dark" }, 40, 40);
  const texts = activity.map((r) => r.segments.map((s) => s.text).join(""));
  const descIndent = lines[0]!.hanging;
  const idx = texts.findIndex((t) =>
    t.startsWith(" ".repeat(HELP_MARGIN) + "/jobs"),
  );
  assert.ok(idx >= 0, "/jobs 行已渲染");
  const first = texts[idx]!;
  assert.equal(
    displayWidth(first) - displayWidth(first.trimStart()),
    HELP_MARGIN,
    "首行行首缩进 = HELP_MARGIN（文本自带缩进）",
  );
  // /jobs 描述超宽 → 紧随的行为折行续行：缩进 == 描述列起点（不再顶格）
  const cont = texts[idx + 1];
  assert.ok(cont !== undefined && cont.trim().length > 0, "有折行续行");
  assert.equal(
    displayWidth(cont) - displayWidth(cont.trimStart()),
    descIndent,
    "续行缩进 == 描述列起点（不穿回第一列）",
  );
});

test("渲染层：超宽命令描述另起一行，行首缩进 = 描述列起点", () => {
  const rows = [
    {
      cmd: "/provider、/effort (/thinking)",
      desc: "无参直达 /model 面板并定位到 provider / effort 列",
    },
  ] as const;
  const lines = helpTableLines(rows);
  const buffer: Buffer = [
    { kind: "notice", text: "本地命令：" },
    ...lines.map((l) => ({
      kind: "notice" as const,
      text: l.text,
      hanging: l.hanging,
    })),
  ];
  const { activity } = buildContentRows(buffer, { themeId: "dark" }, 90, 90);
  const texts = activity.map((r) => r.segments.map((s) => s.text).join(""));
  const descIndent = lines[0]!.hanging;
  const cmdIdx = texts.findIndex((t) =>
    t.startsWith(" ".repeat(HELP_MARGIN) + "/provider"),
  );
  assert.ok(cmdIdx >= 0, "命令行已渲染");
  assert.equal(
    texts[cmdIdx],
    " ".repeat(HELP_MARGIN) + rows[0]!.cmd,
    "命令独占首行（描述不与命令同列）",
  );
  const descRow = texts[cmdIdx + 1];
  assert.ok(descRow !== undefined, "描述行存在（紧随命令行）");
  assert.equal(
    displayWidth(descRow) - displayWidth(descRow.trimStart()),
    descIndent,
    "描述行缩进 == 描述列起点（第二列缩进）",
  );
  assert.equal(
    descRow.trimEnd(),
    " ".repeat(descIndent) + rows[0]!.desc,
    "描述内容紧随第二列缩进之后",
  );
});
