// tests/help.test.ts — /help 双列排版（无边框表格）纯函数单测
//
// 覆盖：命令列定宽对齐、描述列固定起点、每行悬垂缩进 = 描述列起点
// （渲染层折行时续行停靠该列，不穿回第一列）、CJK 补白按显示列计算。
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayWidth } from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import type { Buffer } from "../src/app/state.ts";
import {
  helpTableLines,
  HELP_MARGIN,
  HELP_GAP,
} from "../src/app/layout/help.ts";

const ROWS = [
  { cmd: "/help", desc: "显示本帮助" },
  { cmd: "/clearscreen (/cls)", desc: "清空缓冲(只清显示，不动上下文)" },
  {
    cmd: "/jobs",
    desc: "后台任务面板（只读列表；↑/↓ 选择、PgUp/PgDn 翻页、Enter 取消、Esc 关闭）",
  },
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
    { cmd: "/permission [预设名]", desc: "权限预设" },
    { cmd: "/a", desc: "x" },
  ] as const;
  const lines = helpTableLines(rows);
  const col1 = Math.max(
    displayWidth("/permission [预设名]"),
    displayWidth("/a"),
  );
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

test("行内不再有 \n：每行单物理行，折行统一由渲染层按 hanging 处理", () => {
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
