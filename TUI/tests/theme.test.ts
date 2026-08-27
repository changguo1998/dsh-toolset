// tests/theme.test.ts — 主题模块 + Screen/渲染器主题化单测
//
// 覆盖：内嵌两套配色精确值、ANSI 槽位→hex 解析、Screen 整帧/delta 带主题
// 基底色、styleLine 的 fg/bg 手动 38;2/48;2 + 恢复主题基底、setTheme 使 delta
// 缓存失效、close 恢复 `ESC[0m`、reducer/initialState(normalize)、非法配置兜底。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ansiNameToHex,
  colorFor,
  DEFAULT_THEME,
  normalizeThemeId,
  THEMES,
  themeSgr,
} from "../src/renderer/theme.ts";
import { createRenderer } from "../src/renderer/index.ts";
import { Screen } from "../src/renderer/screen.ts";
import { initialState, reduceState } from "../src/app/state.ts";

/** 累积写入的 fake 输出 */
class FakeWrite {
  out = "";
  call(s: string): void {
    this.out += s;
  }
}

test("内嵌两套配色与 fff terminal-colortheme JSON 一致", () => {
  assert.deepEqual(THEMES.dark, {
    name: "BlueDark",
    ansi: [
      "#434343",
      "#E74684",
      "#84E746",
      "#E7A946",
      "#4684E7",
      "#A946E7",
      "#46E7A9",
      "#D8D8D8",
    ],
    bright: [
      "#787878",
      "#EF87AF",
      "#AFEF87",
      "#EFC787",
      "#87AFEF",
      "#C787EF",
      "#87EFC7",
      "#FFFFFF",
    ],
    background: "#030327",
    foreground: "#FFFFFF",
  });
  assert.deepEqual(THEMES.light, {
    name: "YellowBright",
    ansi: [
      "#000000",
      "#640016",
      "#166400",
      "#644E00",
      "#001664",
      "#4E0064",
      "#00644E",
      "#808080",
    ],
    bright: [
      "#444444",
      "#990021",
      "#166400",
      "#644E00",
      "#002199",
      "#780099",
      "#00644E",
      "#444444",
    ],
    background: "#FBEBB5",
    foreground: "#000000",
  });
  assert.equal(DEFAULT_THEME, "dark");
  assert.equal(normalizeThemeId("dark"), "dark");
  assert.equal(normalizeThemeId("light"), "light");
  assert.equal(normalizeThemeId("garbage"), "dark");
  assert.equal(normalizeThemeId(42), "dark");
  assert.equal(normalizeThemeId(undefined), "dark");
});

test("ANSI 槽位映射:基础色 → ansi[],bright* → bright[],gray → bright[0]", () => {
  const d = THEMES.dark;
  assert.equal(ansiNameToHex(d, "black"), d.ansi[0]);
  assert.equal(ansiNameToHex(d, "green"), d.ansi[2]);
  assert.equal(ansiNameToHex(d, "white"), d.ansi[7]);
  assert.equal(ansiNameToHex(d, "brightBlack"), d.bright[0]);
  assert.equal(ansiNameToHex(d, "brightMagenta"), d.bright[5]);
  assert.equal(ansiNameToHex(d, "brightWhite"), d.bright[7]);
  assert.equal(ansiNameToHex(d, "gray"), d.bright[0]);
  assert.equal(ansiNameToHex(d, "notacolor"), null);
  // 浅色主题同槽位取 YellowBright 调色板
  assert.equal(ansiNameToHex(THEMES.light, "brightMagenta"), "#780099");
});

test("themeSgr 输出 truecolor SGR(前景/背景)", () => {
  assert.equal(themeSgr(THEMES.dark, true), "\x1b[38;2;255;255;255m");
  assert.equal(themeSgr(THEMES.dark, false), "\x1b[48;2;3;3;39m");
  assert.equal(themeSgr(THEMES.light, true), "\x1b[38;2;0;0;0m");
  assert.equal(themeSgr(THEMES.light, false), "\x1b[48;2;251;235;181m");
});

test("colorFor(light,…) 以主题基底前景收尾，绝不出现 `39m`", () => {
  const c = colorFor("light", "brightMagenta")("M");
  assert.ok(c.startsWith("\x1b[38;2;120;0;153m"), "应以前景 SGR 开头");
  assert.ok(c.endsWith("\x1b[38;2;0;0;0m"), "应以 YellowBright 基底前景收尾");
  assert.ok(!c.includes("39m") && !c.includes("\x1b[m"), "不得复位到终端默认");
});

test("Screen.render 每行前缀主题基底前景/背景;setTheme 切换", () => {
  const w = new FakeWrite();
  const screen = new Screen({ write: (s) => w.call(s) });
  screen.setTheme("light");
  screen.render([{ text: "hi" }]);
  const out = w.out;
  // 基底 = YellowBright foreground #000000 + background #FBEBB5
  assert.ok(out.includes("\x1b[38;2;0;0;0m"), "应有浅色基底前景");
  assert.ok(out.includes("\x1b[48;2;251;235;181m"), "应有浅色基底背景");
  // 清屏在基底设置后写入(以当前 bg 填充) —— 顺序:先基底色后清屏
  assert.ok(
    out.indexOf("48;2;251;235;181") < out.indexOf("2J"),
    "基底背景应先于清屏写",
  );
  assert.ok(out.includes("hi"), "文本行应写入");
});

test("Screen.renderDelta 同样带主题基底色(ESC[K 以主题 bg 填充)", () => {
  const w = new FakeWrite();
  const screen = new Screen({ write: (s) => w.call(s) });
  screen.setTheme("dark");
  screen.renderDelta(3, [{ text: "tail", style: { fg: "green" } }]);
  const out = w.out;
  assert.ok(out.includes("\x1b[38;2;255;255;255m"), "delta 应有 dark 基底前景");
  assert.ok(out.includes("\x1b[38;2;132;231;70m"), "delta 样式色按主题解析");
  assert.ok(out.includes("tail"));
});

test("styleLine: fg/bg 分别 38;2/48;2，并以主题基底色收尾", () => {
  const w = new FakeWrite();
  const screen = new Screen({ write: (s) => w.call(s) });
  screen.setTheme("dark");
  screen.render([
    { text: "A", style: { fg: "green" } },
    { text: "B", style: { bg: "yellow" } },
    { text: "C", style: { fg: "blue", bg: "magenta", bold: true } },
  ]);
  const out = w.out;
  // fg green #84E746 → 38;2;132;231;70 ; 恢复前景 #FFFFFF
  assert.ok(out.includes("\x1b[38;2;132;231;70m"), "前景 green 38;2 输出");
  // bg yellow (#E7A946) → 48;2;231;169;70 ; bg magenta (#A946E7)
  assert.ok(out.includes("\x1b[48;2;231;169;70m"), "背景 yellow 48;2 输出");
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
  r.render([{ text: "x" }]);
  assert.ok(w.out.includes("\x1b[48;2;3;3;39m"), "dark 背景应先于清屏");
  w.out = "";
  // 相同的行再次 render → delta 优化,不应重新清屏
  r.render([{ text: "x" }]);
  assert.ok(!w.out.includes("2J"), "同帧走 delta 无清屏");
  // setTheme 后相同行 → 必须全帧重绘(清屏含新背景)
  r.setTheme("light");
  w.out = "";
  r.render([{ text: "x" }]);
  assert.ok(w.out.includes("2J"), "setTheme 后应全帧清屏重绘");
  assert.ok(w.out.includes("\x1b[48;2;251;235;181m"), "清屏含新浅背景");

  // close 恢复终端默认样式
  r.close();
  assert.ok(w.out.endsWith("\x1b[0m"), "close 应输出 ESC[0m");
});

test("Screen.reset 与 reducer set-theme / initialState(theme)", () => {
  const w = new FakeWrite();
  const screen = new Screen({ write: (s) => w.call(s) });
  screen.reset();
  assert.equal(w.out, "\x1b[0m");

  assert.equal(initialState().themeId, "dark");
  assert.equal(initialState("light").themeId, "light");
  const s = reduceState(initialState(), {
    type: "set-theme",
    themeId: "light",
  });
  assert.equal(s.themeId, "light");
});
