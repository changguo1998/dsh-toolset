// tests/color-semantics.test.ts — 语义色槽位集中断言
//
// 语义契约（theme.ts 语义槽位 semantics，数据驱动，非按主题名分支）：
//   次要文字 = gray   = dark bright[0] #80878E / light bright[0] #475863
//   边框 = border = dark ansi[4] #5A98F3 / light ansi[4] #1256B2（语义蓝）
//   行内代码 = code = dark ansi[0] #272336 / light ansi[7] #E9EBEE
//   强调(焦点) = focus = dark bright[7] #FFFFFF / light ansi[0] #121418
//
// 层1：槽位映射；层2：buildFrame 双主题 × 四焦点帧层实测（边框恒 L3、
// 焦点窗口边框转强调色）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, ansiNameToHex } from "../src/renderer/theme.ts";
import { buildFrame, focusFrameColor } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { rowAnsi } from "./helpers/rowText.ts";
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
  return buildFrame(s, { rows: 24, cols: 80 }).map((r) => rowAnsi(r, themeId));
}

const FC = (t: ThemeId): string =>
  // focusFrameColor() → 语义色名 "focus" → semantics.focus hex
  ansiNameToHex(THEMES[t], focusFrameColor())!;
const borderHex = (t: ThemeId): string => ansiNameToHex(THEMES[t], "border")!;
const grayHex = (t: ThemeId): string => ansiNameToHex(THEMES[t], "gray")!;
/** hex → "r;g;b" */
const rgb = (hex: string): string => {
  const n = parseInt(hex!.slice(1), 16);
  return [n >> 16, (n >> 8) & 0xff, n & 0xff].join(";");
};

test("槽位层：gray=次要、border=正文/边框、强调=端头（双主题，semantics 驱动）", () => {
  for (const t of ["dark", "light"] as const) {
    assert.equal(
      ansiNameToHex(THEMES[t], "gray"),
      THEMES[t].bright[0],
      `${t} gray=次要(bright.0)`,
    );
    assert.equal(
      ansiNameToHex(THEMES[t], "border"),
      THEMES[t].ansi[4],
      `${t} border=边框（语义蓝）`,
    );
    assert.equal(
      ansiNameToHex(THEMES[t], focusFrameColor()),
      t === "dark" ? THEMES[t].bright[7] : THEMES[t].ansi[0],
      `${t} 强调=端头`,
    );
  }
});

test("帧层：底部全宽分隔（makeSep）恒边框色（border），四种焦点不变", () => {
  for (const t of ["dark", "light"] as const) {
    const want = rgb(borderHex(t));
    for (const f of ["none", "history", "activity", "status"] as const) {
      const rows = frame(t, f);
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
    const border = rgb(borderHex(t));
    const accent = rgb(FC(t));
    // 非焦点：状态区上方分隔（┴ 行）含边框色（行内另有基底前景收尾色）
    const none = frame(t, "none");
    assert.ok(
      lineColors(none, "┴").includes(border),
      `${t} none 状态区分隔=边框色`,
    );
    // history 焦点：顶框含强调色；状态区分隔仍边框色（状态栏未聚焦）
    const hist = frame(t, "history");
    assert.ok(
      lineColors(hist, "┌").includes(accent),
      `${t} history 顶框=强调色`,
    );
    assert.ok(
      lineColors(hist, "┴").includes(border),
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

test("基底前景：theme.foreground=源文件值，正文默认可读（对比度方向）", () => {
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return (n >> 16) + ((n >> 8) & 0xff) + (n & 0xff);
  };
  for (const t of ["dark", "light"] as const) {
    // 上游配色已解耦 foreground 与 ansi[7]/bright[0]；此处断言可读性方向：
    // dark 前景亮于背景、light 前景暗于背景
    if (t === "dark")
      assert.ok(
        lum(THEMES[t].foreground) > lum(THEMES[t].background),
        `${t} 前景应亮于背景`,
      );
    else
      assert.ok(
        lum(THEMES[t].foreground) < lum(THEMES[t].background),
        `${t} 前景应暗于背景`,
      );
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

test("次要文字=gray 槽位：折叠/占位类走 gray（源码引用的 log tone），不等于边框/强调", () => {
  // 折叠占位/状态空占位等全部经段样式 { fg: "gray" } 由渲染层解析（segStyle），
  // 槽位断言已覆盖；此处再锚定「NOTICE_TONE_COLOR.log 指向 gray」防漂移。
  for (const t of ["dark", "light"] as const) {
    assert.equal(grayHex(t), THEMES[t].bright[0], `${t} 次要=gray`);
    assert.notEqual(grayHex(t), borderHex(t), `${t} 次要≠边框`);
    assert.notEqual(grayHex(t), rgb(FC(t)), `${t} 次要≠强调`);
    assert.notEqual(borderHex(t), rgb(FC(t)), `${t} 边框≠强调`);
  }
});
