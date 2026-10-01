// tests/code-block-gutter.test.ts — #2 代码块整块右缩进 + 左侧行号
//
// 契约：① 语言标记行并入块首（带 `┃` 前缀、与代码列对齐，颜色条不断口，不占行号）；
// ② 块内版式 `<行号 2 列><空白 1 列><代码>`，行号只数代码正文行、从 1 起、固定 2 列
//   （>99 显示 `99+`）；③ 软折行续行再缩进 4 列（相对代码列）并靠右对齐正文右缘；
// ④ 窄窗（宽 < 24）省略行号列。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBox } from "../src/app/layout/build-box.ts";
import { fillBoxTree } from "../src/app/layout/fill.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
import type { BufferLine } from "../src/app/state.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

const THEME: ThemeId = "dark";
const a = (text: string): BufferLine => ({
  text,
  kind: "assistant",
  final: true,
});
const stripRight = (s: string): string => s.replace(/\s+$/, "");

function rows(buf: BufferLine[], width = 60, height = 40): string[] {
  const built = buildBox(buf, { themeId: THEME, width });
  return fillBoxTree(built.panes.dialogue, height, width, THEME).map((r) =>
    r.segments.map((g) => g.text).join(""),
  );
}

test("#2 代码块：语言标记行并入块首且带 ┃（颜色条不断口）", () => {
  const out = rows([a("```bash"), a("echo 1"), a("```")]);
  const lang = out.find((r) => r.includes("bash"));
  assert.ok(lang !== undefined, `存在语言标记行：${JSON.stringify(out)}`);
  assert.match(lang, /^┃ {3}bash/, "语言标记行带 ┃ 且与代码列对齐");
  // 代码行同样带 ┃（连续）
  const code = out.find((r) => r.includes("echo 1"));
  assert.match(code!, /^┃ /, "代码行带 ┃");
});

test("#2 行号：只数代码正文行、从 1 起、固定 2 列", () => {
  const out = rows([a("```"), a("echo 1"), a(""), a("echo 3"), a("```")]);
  assert.match(stripRight(out[0]!), /^┃ 1 echo 1$/, "第 1 行行号");
  assert.match(stripRight(out[1]!), /^┃ 2$/, "空代码行只有行号（计数）");
  assert.match(stripRight(out[2]!), /^┃ 3 echo 3$/, "第 3 行行号（空行计入）");
  assert.ok(!out.some((r) => r.includes("```")), "围栏行不渲染、也不占行号");
});

test("#2 软折行：续行缩进 4 列 + 靠右对齐正文右缘", () => {
  const width = 60;
  const out = rows(
    [
      a("```"),
      a("echo 一段很长的中文代码行用来触发软折行看续行缩进与右对齐"),
      a("```"),
    ],
    width,
  );
  const idx = out.findIndex((r) => r.includes("echo 一段"));
  assert.ok(idx >= 0, `首行存在：${JSON.stringify(out)}`);
  assert.match(out[idx]!, /^┃ 1 echo/, "首行：行号 + 代码");
  // 续行（首行的下一物理行）：┃ 恒在最左（颜色条不断口），缩进 ≥ 行号列 + 4，贴正文右缘
  const cont = out[idx + 1]!;
  assert.match(cont, /^┃ {7,}/, "续行缩进 ≥ 行号列 + 4（再多 4 列）");
  assert.equal(displayWidth(stripRight(cont)), width, "续行靠右对齐到正文右缘");
});

test("#2 行号 >99 显示 99+（固定 2 列）", () => {
  const buf: BufferLine[] = [a("```")];
  for (let i = 1; i <= 105; i++) buf.push(a(`line ${i}`));
  buf.push(a("```"));
  const out = rows(buf, 60, 130);
  const first = out.find((r) => stripRight(r).endsWith("line 1"));
  assert.ok(
    first !== undefined,
    `首行存在：${JSON.stringify(out.slice(0, 3))}`,
  );
  assert.match(stripRight(first), /^┃ 1 line 1$/, "首行行号 1");
  const hundred = out.find((r) => stripRight(r).endsWith("line 100"));
  assert.match(
    stripRight(hundred!),
    /^┃99\+ line 100$/,
    "第 100 行起显示 99+（仍 2 列）",
  );
});

test("#2 窄窗降级：宽 < 24 时省略行号列", () => {
  const out = rows([a("```"), a("echo 1"), a("```")], 20);
  const code = out.find((r) => r.includes("echo 1"));
  assert.match(stripRight(code!), /^┃ ?echo 1/, "窄窗代码紧跟前缀（无行号列）");
  assert.ok(!/\d/.test(stripRight(code!).slice(0, 6)), "窄窗不显示行号");
});

test("#2 软折行：折行处成对标记（上一行尾 ↩ / 下一行首 ↪），且不再多折一行", () => {
  const width = 60;
  const out = rows(
    [a("```"), a(`echo ${"这一行很长".repeat(30)}需要折三行以上`), a("```")],
    width,
  );
  const code = out.filter((r) => r.trim() !== "");
  const idx = code.findIndex((r) => r.includes("echo"));
  assert.ok(idx >= 0, `找到代码首行：${JSON.stringify(out)}`);
  const first = stripRight(code[idx]!);
  assert.ok(first.endsWith("↩"), `断行处行尾带 ↩：${first}`);
  // 每一行（含续行）都不得超过可用宽——箭头已预留 1 列，不会再被挤到下一行
  for (const r of out) {
    assert.ok(
      displayWidth(stripRight(r)) <= width,
      `行宽不超 ${width}：${JSON.stringify(r)}`,
    );
  }
  // 续行也带箭头；末行不带（末尾是正文）
  const conts = code.slice(idx + 1);
  assert.ok(conts.length >= 2, `至少两行续行：${JSON.stringify(conts)}`);
  assert.ok(conts[0]!.includes("↪"), "续行行首带 ↪");
  assert.ok(conts[0]!.endsWith("↩"), "中间续行仍在断行处带 ↩");
  assert.ok(!stripRight(conts.at(-1)!).endsWith("↩"), "末行不带行尾标记");
  assert.ok(conts.at(-1)!.includes("↪"), "末行行首仍带 ↪");
});
