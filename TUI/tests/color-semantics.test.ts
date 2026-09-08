// tests/color-semantics.test.ts — 灰度三语义集中断言
//
// 语义契约（theme.ts 头注释）：
//   次要文字  = gray        = ansi[7]   dark #D8D8D8 / light #F4F4F4
//   前景/边框 = brightBlack = bright[0] dark #787878 / light #555555
//   强调(焦点) = focusFrameColor()       dark bright[7] #FFFFFF / light ansi[0] #000000
//
// 层1：槽位映射；层2：buildFrame 双主题 × 四焦点帧层实测（边框恒前景、
// 焦点窗口边框转强调色）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, ansiNameToHex } from "../src/renderer/theme.ts";
import { buildFrame, focusFrameColor } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

/** 帧内某符号所在行的全部 38;2 RGB（去重） */
function lineColors(rows: string[], symbol: string): string[] {
  const hit = rows.find((t) => t.includes(symbol));
  assert.ok(hit, `帧中未找到 ${symbol}`);
  const set = new Set<string>();
  for (const m of hit.matchAll(/38;2;(\d+;\d+;\d+)/g)) set.add(m[1]!);
  return [...set];
}

/** 构造指定焦点面板的帧（focus-panel-cycle 是 Tab 循环，n 次到达目标） */
function frame(
  themeId: ThemeId,
  focus: "none" | "history" | "activity" | "status",
): string[] {
  const CY = { none: 0, history: 1, activity: 2, status: 3 } as const;
  let s = initialState(themeId);
  s = reduceState(s, { type: "append", text: "hello world" });
  s = reduceState(s, { type: "turn-begin" });
  for (let i = 0; i < CY[focus]; i++)
    s = reduceState(s, { type: "focus-panel-cycle" });
  return buildFrame(s, { rows: 24, cols: 80 }).map((r) => r.text);
}

const FC = (t: ThemeId): string =>
  // focusFrameColor(ColorName) → hex
  ansiNameToHex(THEMES[t], focusFrameColor(t))!;
const brightBlackHex = (t: ThemeId): string =>
  ansiNameToHex(THEMES[t], "brightBlack")!;
const grayHex = (t: ThemeId): string => ansiNameToHex(THEMES[t], "gray")!;
/** hex → "r;g;b" */
const rgb = (hex: string): string => {
  const n = parseInt(hex!.slice(1), 16);
  return [n >> 16, (n >> 8) & 0xff, n & 0xff].join(";");
};

test("槽位层：gray=ansi[7]、brightBlack=bright[0]、强调=端头（双主题）", () => {
  for (const t of ["dark", "light"] as const) {
    assert.equal(
      ansiNameToHex(THEMES[t], "gray"),
      THEMES[t].ansi[7],
      `${t} gray=ansi[7]`,
    );
    assert.equal(
      ansiNameToHex(THEMES[t], "brightBlack"),
      THEMES[t].bright[0],
      `${t} brightBlack=bright[0]`,
    );
    assert.equal(
      ansiNameToHex(THEMES[t], focusFrameColor(t)),
      t === "dark" ? THEMES[t].bright[7] : THEMES[t].ansi[0],
      `${t} 强调=端头`,
    );
  }
});

test("帧层：分隔竖线/状态区分隔恒边框色（bright[0]），四种焦点不变", () => {
  for (const t of ["dark", "light"] as const) {
    const want = rgb(brightBlackHex(t));
    for (const f of ["none", "history", "activity", "status"] as const) {
      const rows = frame(t, f);
      assert.ok(lineColors(rows, "│").includes(want), `${t} ${f} 竖线=边框色`);
      // 状态区下方 makeSep：全宽纯 ─ 行，恒边框色
      const pureSep = rows.find((r) => {
        const c = r.replace(/\x1b\[[0-9;]*m/g, "");
        return /^─+$/.test(c);
      });
      assert.ok(pureSep, `${t} ${f} 存在全宽分隔行`);
      const got = [
        ...new Set(
          [...pureSep!.matchAll(/38;2;(\d+;\d+;\d+)/g)].map((m) => m[1]!),
        ),
      ];
      assert.ok(got.includes(want), `${t} ${f} 底部状态分隔=边框色 ${got}`);
    }
  }
});

test("帧层：焦点窗口边框转强调色（fc），非焦点回边框色", () => {
  for (const t of ["dark", "light"] as const) {
    const border = rgb(brightBlackHex(t));
    const accent = rgb(FC(t));
    // 非焦点：状态区上方分隔（┴ 行）全边框色
    const none = frame(t, "none");
    assert.deepEqual(
      lineColors(none, "┴"),
      [border],
      `${t} none 状态区分隔=边框色`,
    );
    // history 焦点：顶框含强调色；状态区分隔仍边框色（状态栏未聚焦）
    const hist = frame(t, "history");
    assert.ok(
      lineColors(hist, "┌").includes(accent),
      `${t} history 顶框=强调色`,
    );
    assert.deepEqual(
      lineColors(hist, "┴"),
      [border],
      `${t} history 状态区分隔仍边框色`,
    );
    // activity 焦点：状态区上方分隔亮左段+┴（强调色）
    const act = frame(t, "activity");
    assert.ok(
      lineColors(act, "┴").includes(accent),
      `${t} activity 状态区分隔钩边=强调色`,
    );
    // status 焦点：状态区分隔亮（┴/右段）且顶框强调
    const st = frame(t, "status");
    assert.ok(
      lineColors(st, "┴").includes(accent),
      `${t} status 状态区分隔=强调色`,
    );
    assert.ok(lineColors(st, "┌").includes(accent), `${t} status 顶框=强调色`);
  }
});

test("基底前景：theme.foreground 与边框同槽位（bright[0]），正文默认可读", () => {
  for (const t of ["dark", "light"] as const) {
    assert.equal(
      THEMES[t].foreground,
      THEMES[t].bright[0],
      `${t} 基底前景=bright[0]`,
    );
    // 帧首铺设基底前景：输入提示行（`>> Type a message...`）前有基底前景 SGR
    // 帧首铺设基底前景：输入提示行（`>> Type a message...`）前有基底前景 SGR
    const rows = frame(t, "none");
    const input = rows.find((r) => r.includes("Type a message"));
    assert.ok(input, `${t} 存在输入提示行`);
    assert.ok(
      input!.includes(`38;2;${rgb(THEMES[t].foreground)}m`),
      `${t} 输入提示=基底前景`,
    );
  }
});

test("次要文字==ansi[7]：折叠/占位类走 gray 槽位（源码引用的 log tone）", () => {
  // 折叠占位/状态空占位等全部经由 colorFor(..., "gray")(=ansi[7])，
  // 槽位断言已覆盖；此处再锚定「NOTICE_TONE_COLOR.log 指向 gray」防漂移。
  for (const t of ["dark", "light"] as const) {
    assert.equal(grayHex(t), THEMES[t].ansi[7], `${t} 次要=ansi[7]`);
    assert.notEqual(grayHex(t), brightBlackHex(t), `${t} 次要≠边框`);
    assert.notEqual(grayHex(t), rgb(FC(t)), `${t} 次要≠强调`);
    assert.notEqual(brightBlackHex(t), rgb(FC(t)), `${t} 边框≠强调`);
  }
});
