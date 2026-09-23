// tests/theme.test.ts — 主题模块 + Screen/渲染器主题化单测
//
// 覆盖：内置兜底两套配色精确值（= 当前上游 terminal-colortheme 快照）、ANSI
// 槽位→hex 解析（含语义槽位 gray/border/code/focus 数据化）、Screen 整帧/delta
// 带主题基底色、styleLine 的 fg/bg 手动 38;2/48;2 + 恢复主题基底、setTheme 使
// delta 缓存失效、close 恢复 `ESC[0m`、reducer/initialState(normalize)、非法配置兜底。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ansiNameToHex,
  DEFAULT_THEME,
  normalizeThemeId,
  THEMES,
  themeSgr,
} from "../src/renderer/theme.ts";
import { createRenderer } from "../src/renderer/index.ts";
import { Screen, segStyle } from "../src/renderer/screen.ts";
import { initialState, reduceState } from "../src/app/state.ts";

/** 累积写入的 fake 输出 */
class FakeWrite {
  out = "";
  call(s: string): void {
    this.out += s;
  }
}

test("内置两套配色与 fff terminal-colortheme JSON 一致（含语义槽位）", () => {
  assert.deepEqual(THEMES.dark, {
    name: "fffdark",
    ansi: [
      "#272336",
      "#FD0013",
      "#61D383",
      "#E9C944",
      "#5A98F3",
      "#C582ED",
      "#64D6E6",
      "#FFFBF0",
    ],
    bright: [
      "#80878E",
      "#FFA1AD",
      "#9EEFB2",
      "#FAE289",
      "#A7CBFF",
      "#E4BCFF",
      "#9FEEFA",
      "#FFFFFF",
    ],
    background: "#0A1127",
    foreground: "#C9DCDE",
    semantics: {
      gray: "#80878E", // bright.0
      border: "#5A98F3", // ansi.4
      code: "#272336", // ansi.0
      focus: "#FFFFFF", // bright.7
    },
  });
  assert.deepEqual(THEMES.light, {
    name: "ffflight",
    ansi: [
      "#121418",
      "#D8000F",
      "#007B3A",
      "#8F7700",
      "#1256B2",
      "#813CA6",
      "#007784",
      "#E9EBEE",
    ],
    bright: [
      "#475863",
      "#FFB6C5",
      "#9EDAAC",
      "#DFCF96",
      "#A2C7FF",
      "#DFB3FC",
      "#9ED5DE",
      "#FFFFFF",
    ],
    background: "#FFF6E1",
    foreground: "#3D3B4F",
    semantics: {
      gray: "#475863", // bright.0（新配色下保证米色底可读）
      border: "#1256B2", // ansi.4
      code: "#E9EBEE", // ansi.7
      focus: "#121418", // ansi.0
    },
  });
  assert.equal(DEFAULT_THEME, "dark");
  assert.equal(normalizeThemeId("dark"), "dark");
  assert.equal(normalizeThemeId("light"), "light");
  assert.equal(normalizeThemeId("garbage"), "dark");
  assert.equal(normalizeThemeId(42), "dark");
  assert.equal(normalizeThemeId(undefined), "dark");
});

test("ANSI 槽位映射:基础色 → ansi[],bright* → bright[],四种语义槽位按 theme.semantics 解析", () => {
  const d = THEMES.dark;
  assert.equal(ansiNameToHex(d, "black"), d.ansi[0]);
  assert.equal(ansiNameToHex(d, "green"), d.ansi[2]);
  assert.equal(ansiNameToHex(d, "white"), d.ansi[7]);
  assert.equal(ansiNameToHex(d, "brightBlack"), d.bright[0]);
  assert.equal(ansiNameToHex(d, "brightMagenta"), d.bright[5]);
  assert.equal(ansiNameToHex(d, "brightWhite"), d.bright[7]);
  // 次要 gray：dark=bright[0] / light=bright[0]（差异值但同槽位语义）
  assert.equal(ansiNameToHex(d, "gray"), d.bright[0], "dark gray=bright[0]");
  assert.equal(
    ansiNameToHex(THEMES.light, "gray"),
    THEMES.light.bright[0],
    "light gray=bright[0]",
  );
  // 边框 border：dark=ansi[4] / light=ansi[4]（语义蓝）
  assert.equal(ansiNameToHex(d, "border"), d.ansi[4], "dark border=ansi[4]");
  assert.equal(
    ansiNameToHex(THEMES.light, "border"),
    THEMES.light.ansi[4],
    "light border=ansi[4]",
  );
  // 行内代码 code：dark=ansi[0] / light=ansi[7]
  assert.equal(ansiNameToHex(d, "code"), d.ansi[0], "dark code=ansi[0]");
  assert.equal(
    ansiNameToHex(THEMES.light, "code"),
    THEMES.light.ansi[7],
    "light code=ansi[7]",
  );
  // 焦点框 focus：dark=bright[7] / light=ansi[0]
  assert.equal(ansiNameToHex(d, "focus"), d.bright[7], "dark focus=bright[7]");
  assert.equal(
    ansiNameToHex(THEMES.light, "focus"),
    THEMES.light.ansi[0],
    "light focus=ansi[0]",
  );
  assert.equal(ansiNameToHex(d, "notacolor"), null);
  // 浅色主题同槽位取 ffflight 调色板
  assert.equal(ansiNameToHex(THEMES.light, "brightMagenta"), "#DFB3FC");
});

test("themeSgr 输出 truecolor SGR(前景/背景)", () => {
  assert.equal(themeSgr(THEMES.dark, true), "\x1b[38;2;201;220;222m"); // 基底前景 #C9DCDE
  assert.equal(themeSgr(THEMES.dark, false), "\x1b[48;2;10;17;39m");
  assert.equal(themeSgr(THEMES.light, true), "\x1b[38;2;61;59;79m"); // 基底前景 #3D3B4F
  assert.equal(themeSgr(THEMES.light, false), "\x1b[48;2;255;246;225m");
});

test("segStyle(主题, 前景槽位) 以主题基底前景收尾，绝不出现 `39m`", () => {
  const c = segStyle(
    { text: "M", style: { fg: "brightMagenta" } },
    THEMES.light,
  );
  assert.ok(c.startsWith("\x1b[38;2;223;179;252m"), "应以前景 SGR 开头");
  assert.ok(c.endsWith("\x1b[38;2;61;59;79m"), "应以 ffflight 基底前景收尾");
  assert.ok(!c.includes("39m") && !c.includes("\x1b[m"), "不得复位到终端默认");
});

test("Screen.render 每行前缀主题基底前景/背景;setTheme 切换", () => {
  const w = new FakeWrite();
  const screen = new Screen({ write: (s) => w.call(s) });
  screen.setTheme("light");
  screen.render([{ segments: [{ text: "hi" }] }]);
  const out = w.out;
  // 基底 = ffflight foreground #3D3B4F + background #FFF6E1
  assert.ok(out.includes("\x1b[38;2;61;59;79m"), "应有浅色基底前景");
  assert.ok(out.includes("\x1b[48;2;255;246;225m"), "应有浅色基底背景");
  // 清屏在基底设置后写入(以当前 bg 填充) —— 顺序:先基底色后清屏
  assert.ok(
    out.indexOf("48;2;255;246;225") < out.indexOf("2J"),
    "基底背景应先于清屏写",
  );
  assert.ok(out.includes("hi"), "文本行应写入");
});

test("Screen.renderDelta 同样带主题基底色(ESC[K 以主题 bg 填充)", () => {
  const w = new FakeWrite();
  const screen = new Screen({ write: (s) => w.call(s) });
  screen.setTheme("dark");
  screen.renderDelta(3, [
    { segments: [{ text: "tail", style: { fg: "green" } }] },
  ]);
  const out = w.out;
  assert.ok(
    out.includes("\x1b[38;2;201;220;222m"),
    "delta 应有 dark 基底前景 #C9DCDE",
  );
  assert.ok(out.includes("\x1b[38;2;97;211;131m"), "delta 样式色按主题解析");
  assert.ok(out.includes("tail"));
});

test("styleLine: fg/bg 分别 38;2/48;2，并以主题基底色收尾", () => {
  const w = new FakeWrite();
  const screen = new Screen({ write: (s) => w.call(s) });
  screen.setTheme("dark");
  screen.render([
    { segments: [{ text: "A", style: { fg: "green" } }] },
    { segments: [{ text: "B", style: { bg: "yellow" } }] },
    {
      segments: [
        { text: "C", style: { fg: "blue", bg: "magenta", bold: true } },
      ],
    },
  ]);
  const out = w.out;
  // fg green #61D383 → 38;2;97;211;131
  assert.ok(out.includes("\x1b[38;2;97;211;131m"), "前景 green 38;2 输出");
  // bg yellow (#E9C944) → 48;2;233;201;68 ; bg magenta (#C582ED)
  assert.ok(out.includes("\x1b[48;2;233;201;68m"), "背景 yellow 48;2 输出");
  assert.ok(out.includes("\x1b[1m") && out.includes("\x1b[22m"), "bold 1m/22m");
});

test("createRenderer.close 输出 SGR 复位;setTheme 使 delta 缓存失效全帧重绘", () => {
  const w = new FakeWrite();
  const r = createRenderer({
    write: (s) => w.call(s),
    rawMode: false,
    delta: true,
    exitOnClose: false,
  });
  // 首帧 dark 清屏含 dark 背景
  r.render([{ segments: [{ text: "x" }] }]);
  assert.ok(w.out.includes("\x1b[48;2;10;17;39m"), "dark 背景应先于清屏");
  w.out = "";
  // 相同的行再次 render → delta 优化,不应重新清屏
  r.render([{ segments: [{ text: "x" }] }]);
  assert.ok(!w.out.includes("2J"), "同帧走 delta 无清屏");
  // setTheme 后相同行 → 必须全帧重绘(清屏含新背景)
  r.setTheme("light");
  w.out = "";
  r.render([{ segments: [{ text: "x" }] }]);
  assert.ok(w.out.includes("2J"), "setTheme 后应全帧清屏重绘");
  assert.ok(w.out.includes("\x1b[48;2;255;246;225m"), "清屏含新浅背景");

  // close 恢复终端默认样式
  r.close();
  assert.ok(w.out.endsWith("\x1b[0m"), "close 应输出 ESC[0m");
});

test("Screen.reset 与 reducer set-theme / initialState(theme)", () => {
  const w = new FakeWrite();
  const screen = new Screen({ write: (s) => w.call(s) });
  screen.reset();
  // reset 先补发同步输出结束（防同步块内异常收尾卡住终端），再恢复默认样式
  assert.equal(w.out, "\x1b[?2026l\x1b[0m");

  assert.equal(initialState().themeId, "dark");
  assert.equal(initialState("light").themeId, "light");
  const s = reduceState(initialState(), {
    type: "set-theme",
    themeId: "light",
  });
  assert.equal(s.themeId, "light");
});
