// tests/help.test.ts — /help 双列排版（无边框表格）纯函数单测
//
// 覆盖：命令列按 4 空格档位逐行落档（封顶 HELP_CMD_MAX）、超宽命令描述另起
// 一行缩进到封顶档位、每行悬垂缩进 = 该行描述列起点（渲染层折行时续行停靠
// 该列，不穿回第一列）、CJK 按显示列算档位。
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayWidth } from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import type { HistoryRow } from "../src/app/state.ts";
import {
  helpTableLines,
  helpSortKey,
  sortHelpRows,
  HELP_MARGIN,
  HELP_UNIT,
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

/** 单行命令的档位：4 × (⌊min(显示宽, HELP_CMD_MAX) / 4⌋ + 1) */
function stopsOf(cmd: string): number {
  const w = displayWidth(cmd);
  return HELP_UNIT * (Math.floor(Math.min(w, HELP_CMD_MAX) / HELP_UNIT) + 1);
}

/** 描述列起点（绝对列）= 行首缩进 + 该行档位 */
function descColOf(cmd: string): number {
  return HELP_MARGIN + stopsOf(cmd);
}

/** 期望的命令列前缀（行首缩进 + 命令 + 档位补白）：前缀之后紧跟描述 */
function expectedPrefix(cmd: string): string {
  return (
    " ".repeat(HELP_MARGIN) + cmd + " ".repeat(stopsOf(cmd) - displayWidth(cmd))
  );
}

/** 命令后补白列数（按显示列） */
function padOf(cmd: string): number {
  return stopsOf(cmd) - displayWidth(cmd);
}

test("/help 行按 4 空格档位落档：描述列 = 行首缩进 + 档位，悬垂缩进随该行", () => {
  const lines = helpTableLines(ROWS);
  // 本组命令宽均 5 → 档位 8 → 描述列绝对列 10（行首 2 + 4 的倍数）
  for (let i = 0; i < ROWS.length; i++) {
    const { text, hanging } = lines[i]!;
    const cmd = ROWS[i]!.cmd;
    assert.equal(hanging, descColOf(cmd), "悬垂缩进 = 该行描述列起点");
    assert.equal(
      (hanging - HELP_MARGIN) % HELP_UNIT,
      0,
      "描述列落在行首之后 4 的倍数档",
    );
    const prefix = expectedPrefix(cmd);
    assert.equal(
      displayWidth(prefix),
      descColOf(cmd),
      "前缀显示宽 = 描述列起点",
    );
    assert.ok(padOf(cmd) >= 1, "命令后至少 1 空格");
    assert.ok(text.startsWith(prefix), `档位前缀对齐: ${JSON.stringify(text)}`);
    assert.equal(text.slice(prefix.length), ROWS[i]!.desc, "前缀之后紧跟描述");
  }
});

test("窄命令逐字符回归：/a 与 /bb 同档（绝对列 6）、/ccc 下一档（绝对列 10）", () => {
  const rows = [
    { cmd: "/a", desc: "x" },
    { cmd: "/bb", desc: "y" },
    { cmd: "/ccc", desc: "z" },
  ] as const;
  const lines = helpTableLines(rows);
  assert.deepEqual(
    lines.map((l) => l.text),
    [
      "  /a  x", // 宽 2 → 档 4 → 补 2 空格
      "  /bb y", // 宽 3 → 档 4 → 补 1 空格（与 /a 同列）
      "  /ccc    z", // 宽 4 → 档 8 → 补 4 空格
    ],
    "三例逐字符成立（行首缩进均为 2）",
  );
  assert.deepEqual(
    lines.map((l) => l.hanging),
    [6, 6, 10],
    "悬垂缩进逐行取该行档位（/a 与 /bb 同列、/ccc 下一档）",
  );
  assert.equal(padOf("/a"), 2);
  assert.equal(padOf("/bb"), 1);
  assert.equal(padOf("/ccc"), 4);
});

test("档位边界表：宽 1..10 逐档，宽 9 / 10 落在绝对列 14，补白恒 ≥ 1", () => {
  const cases = [
    // [命令显示宽, 档位, 描述列绝对列, 补白]
    [1, 4, 6, 3],
    [2, 4, 6, 2],
    [3, 4, 6, 1],
    [4, 8, 10, 4],
    [5, 8, 10, 3],
    [6, 8, 10, 2],
    [7, 8, 10, 1],
    [8, 12, 14, 4],
    [9, 12, 14, 3],
    [10, 12, 14, 2],
  ] as const;
  for (const [w, stops, descCol, pad] of cases) {
    const cmd = "/" + "x".repeat(w - 1);
    assert.equal(displayWidth(cmd), w, `构造的命令宽为 ${w}`);
    const lines = helpTableLines([{ cmd, desc: "d" }]);
    assert.equal(lines.length, 1, `宽 ${w} 不拆行（等于上限也不拆）`);
    assert.equal(stopsOf(cmd), stops, `宽 ${w} 的档位`);
    assert.equal(lines[0]!.hanging, descCol, `宽 ${w} 的描述列绝对列`);
    assert.equal(padOf(cmd), pad, `宽 ${w} 的补白`);
    assert.equal(
      lines[0]!.text,
      " ".repeat(HELP_MARGIN) + cmd + " ".repeat(pad) + "d",
      `宽 ${w} 的行文本逐字符`,
    );
  }
});

test("CJK 档位按显示列：命令含 CJK 时落档后描述列仍为 4 的倍数", () => {
  const rows = [
    { cmd: "/预设 <n>", desc: "权限预设" }, // 显示宽 9 → 档 12 → 绝对列 14
    { cmd: "/a", desc: "x" }, // 显示宽 2 → 档 4 → 绝对列 6
  ] as const;
  const lines = helpTableLines(rows);
  assert.equal(displayWidth("/预设 <n>"), 9, "CJK 按显示列计宽");
  assert.equal(lines[0]!.hanging, HELP_MARGIN + 12, "CJK 命令落档");
  assert.equal(lines[1]!.hanging, HELP_MARGIN + 4, "短命令各自落档");
  assert.equal(
    lines[0]!.text,
    "  /预设 <n>   权限预设",
    "CJK 补白按显示列（补 3 空格）",
  );
  assert.equal(lines[1]!.text, "  /a  x", "短命令补 2 空格");
});

test("逐行 hanging 差异：同一表内窄命令与宽命令描述列不同列", () => {
  const rows = [
    { cmd: "/a", desc: "一" }, // 宽 2 → 绝对列 6
    { cmd: "/guard", desc: "二" }, // 宽 6 → 档 8 → 绝对列 10
    { cmd: "/abcdefgh", desc: "三" }, // 宽 9 → 档 12 → 绝对列 14
  ] as const;
  const lines = helpTableLines(rows);
  assert.deepEqual(
    lines.map((l) => l.hanging),
    [6, 10, 14],
    "悬垂缩进逐行取值（不再全表一个值）",
  );
  assert.equal(lines[0]!.text, "  /a  一", "宽 2 → 补 2 空格到档 4");
  assert.equal(lines[1]!.text, "  /guard  二", "宽 6 → 补 2 空格");
  assert.equal(lines[2]!.text, "  /abcdefgh   三", "宽 9 → 补 3 空格");
});

test("命令超宽（> HELP_CMD_MAX）：命令独占一行、描述另起一行缩进到封顶档位 14", () => {
  const rows = [
    {
      cmd: "/provider、/effort (/thinking)",
      desc: "无参直达 /model 面板并定位到 provider / effort 列",
    },
    { cmd: "/jobs", desc: "后台任务面板" },
  ] as const;
  const cappedCol = HELP_MARGIN + 12; // stops(10) = 12 → 绝对列 14
  const lines = helpTableLines(rows);
  assert.equal(lines.length, 3, "超宽命令拆出两行 + 普通命令一行");
  assert.equal(
    lines[0]!.hanging,
    cappedCol,
    "命令行悬垂缩进 = 封顶档位（否则会被 30 列命令撑到 34 列）",
  );
  assert.equal(lines[1]!.hanging, cappedCol, "描述行悬垂缩进 = 封顶档位");
  assert.equal(
    lines[0]!.text,
    " ".repeat(HELP_MARGIN) + rows[0]!.cmd,
    "命令独占一行",
  );
  assert.equal(
    lines[1]!.text,
    " ".repeat(cappedCol) + rows[0]!.desc,
    "描述另起一行且缩进 = 封顶档位（绝对列 14）",
  );
  const short = lines[2]!;
  assert.equal(short.hanging, descColOf("/jobs"), "未超宽命令按自身档位");
  assert.ok(!short.text.includes("\n"), "未超宽命令保持单物理行");
  const prefix = expectedPrefix("/jobs");
  assert.ok(short.text.startsWith(prefix), "未超宽命令仍按自身档位补白");
  assert.equal(short.text.slice(prefix.length), rows[1]!.desc);
});

test("刚好越过上限（宽 11）即拆行；等于上限（宽 10）不拆", () => {
  const over = "/" + "x".repeat(10); // 宽 11
  const atCap = "/" + "x".repeat(9); // 宽 10
  assert.equal(
    helpTableLines([{ cmd: over, desc: "d" }]).length,
    2,
    "宽 11 拆行",
  );
  assert.equal(
    helpTableLines([{ cmd: atCap, desc: "d" }]).length,
    1,
    "宽 10 不拆行",
  );
  assert.equal(
    helpTableLines([{ cmd: over, desc: "d" }])[0]!.hanging,
    HELP_MARGIN + 12,
    "拆行取封顶档位",
  );
});

test("全短命令列表：各自落档、不触发拆行（HELP_CMD_MAX 仅为上限）", () => {
  const rows = [
    { cmd: "/quit", desc: "退出" },
    { cmd: "/copy", desc: "复制最后一条模型回复" },
  ] as const;
  const lines = helpTableLines(rows);
  assert.ok(
    rows.every((r) => displayWidth(r.cmd) < HELP_CMD_MAX),
    "本组命令均短于上限",
  );
  assert.equal(lines[0]!.hanging, descColOf("/quit"));
  assert.equal(lines[1]!.hanging, descColOf("/copy"));
  for (const l of lines) assert.ok(!l.text.includes("\n"), "短命令无换行");
});

test("行内不再有 \n（未超宽行）：每行单物理行，折行统一由渲染层按 hanging 处理", () => {
  for (const { text } of helpTableLines(ROWS)) {
    assert.ok(!text.includes("\n"), "每条 help 行应为单一物理行");
  }
});

test("渲染层折行：help notice 续行停靠该行描述列（不穿回第一列）", () => {
  const lines = helpTableLines(ROWS);
  const buffer: HistoryRow[] = [
    { kind: "notice", text: "本地命令：" },
    ...lines.map((l) => ({
      kind: "notice" as const,
      text: l.text,
      hanging: l.hanging,
    })),
  ];
  // 窄活动 pane（40 列）强制 /jobs 描述折行
  const { activity } = buildContentRows(buffer, {}, 40, 40);
  const texts = activity.map((r) => r.segments.map((s) => s.text).join(""));
  const jobsLine = lines[ROWS.findIndex((r) => r.cmd === "/jobs")]!;
  const descIndent = jobsLine.hanging;
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
  // /jobs 描述超宽 → 紧随的行为折行续行：缩进 == 该行描述列起点（不再顶格）
  const cont = texts[idx + 1];
  assert.ok(cont !== undefined && cont.trim().length > 0, "有折行续行");
  assert.equal(
    displayWidth(cont) - displayWidth(cont.trimStart()),
    descIndent,
    "续行缩进 == 该行描述列起点（不穿回第一列）",
  );
});

test("渲染层：超宽命令描述另起一行，行首缩进 = 封顶档位 14", () => {
  const rows = [
    {
      cmd: "/provider、/effort (/thinking)",
      desc: "无参直达 /model 面板并定位到 provider / effort 列",
    },
  ] as const;
  const lines = helpTableLines(rows);
  const buffer: HistoryRow[] = [
    { kind: "notice", text: "本地命令：" },
    ...lines.map((l) => ({
      kind: "notice" as const,
      text: l.text,
      hanging: l.hanging,
    })),
  ];
  const { activity } = buildContentRows(buffer, {}, 90, 90);
  const texts = activity.map((r) => r.segments.map((s) => s.text).join(""));
  const descIndent = lines[0]!.hanging;
  assert.equal(descIndent, 14, "封顶档位绝对列 14");
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
    "描述行缩进 == 封顶档位（绝对列 14）",
  );
  assert.equal(
    descRow.trimEnd(),
    " ".repeat(descIndent) + rows[0]!.desc,
    "描述内容紧随第二列缩进之后",
  );
});

test("字母序：条目按首个命令名升序（别名/参数/顿号合并条目不干扰）", () => {
  const rows = [
    { cmd: "/collapse on|off", desc: "a" },
    { cmd: "/stats (/usage /context)", desc: "b" },
    { cmd: "/model [provider/]model", desc: "c" },
    { cmd: "/provider、/effort (/thinking)", desc: "d" },
    { cmd: "/help", desc: "e" },
  ];
  assert.deepEqual(
    sortHelpRows(rows).map((r) => r.cmd),
    [
      "/collapse on|off",
      "/help",
      "/model [provider/]model",
      "/provider、/effort (/thinking)",
      "/stats (/usage /context)",
    ],
    "按首个命令名升序",
  );
  // 排序键：取首个命令名（去 `/`，到空白/顿号/逗号为止）
  assert.equal(helpSortKey("/provider、/effort (/thinking)"), "provider");
  assert.equal(helpSortKey("/clearscreen (/cls)"), "clearscreen");
  assert.equal(helpSortKey("/theme [dark|light|toggle]"), "theme");
  // 稳定排序：同键条目保持原相对顺序
  assert.deepEqual(
    sortHelpRows([
      { cmd: "/jobs", desc: "先" },
      { cmd: "/jobs [id]", desc: "后" },
    ]).map((r) => r.desc),
    ["先", "后"],
  );
});
