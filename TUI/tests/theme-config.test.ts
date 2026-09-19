// tests/theme-config.test.ts — 主题调色板配置解析（resolveThemes）单测
//
// 覆盖：无配置/默认链、paletteDir 文件读取（内联 > 文件 > 内置优先级）、
// 非法 hex/8 项回落与告警、semantics 槽位引用（ansi.N/bright.N/字面 hex）、
// paletteDir:" 禁用文件查找、active 归一、config.normalizeConfig 的 theme 段，
// 以及注册表→渲染器贯通（注入 themes 的语义色必须落到 SGR 字节）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveThemes } from "../src/renderer/theme-config.ts";
import {
  THEMES,
  type ColorTheme,
  type ThemeId,
} from "../src/renderer/theme.ts";
import { normalizeConfig } from "../src/app/config.ts";
import type { TuiThemeConfig } from "../src/app/config.ts";
import { createRenderer } from "../src/renderer/index.ts";
import { Screen, type FrameRow } from "../src/renderer/screen.ts";

/** 建一个含 fffdark.json/ffflight.json 的临时调色板目录，返回路径（用完 cleanup） */
function tempPaletteDir(dark: object, light: object): string {
  const dir = mkdtempSync(join(tmpdir(), "tui-theme-"));
  writeFileSync(join(dir, "fffdark.json"), JSON.stringify(dark));
  writeFileSync(join(dir, "ffflight.json"), JSON.stringify(light));
  return dir;
}

const CUSTOM_DARK = {
  ansi: [
    "#111111",
    "#222222",
    "#333333",
    "#444444",
    "#555555",
    "#666666",
    "#777777",
    "#888888",
  ],
  bright: [
    "#999999",
    "#AAAAAA",
    "#BBBBBB",
    "#CCCCCC",
    "#DDDDDD",
    "#EEEEEE",
    "#FF0000",
    "#FFFFFF",
  ],
  background: "#010203",
  foreground: "#040506",
  name: "fffdark",
};

test("无配置（paletteDir 禁用）→ 内置兜底主题，active 默认 dark", () => {
  // paletteDir:"" 显式禁用文件查找（不依赖机器上是否有 ~/fff）
  const r = resolveThemes({
    active: undefined,
    paletteDir: "",
  } as unknown as TuiThemeConfig);
  assert.deepEqual(r.themes.dark, THEMES.dark);
  assert.deepEqual(r.themes.light, THEMES.light);
  assert.equal(r.active, "dark");
  assert.deepEqual(r.warnings, []);
});

test("paletteDir 文件读取：dark/light 取上游文件全套字段", () => {
  const dir = tempPaletteDir(CUSTOM_DARK, THEMES.light);
  try {
    const r = resolveThemes({ active: "light", paletteDir: dir });
    assert.equal(r.themes.dark.background, "#010203");
    assert.equal(r.themes.dark.foreground, "#040506");
    assert.deepEqual([...r.themes.dark.ansi], CUSTOM_DARK.ansi);
    assert.deepEqual([...r.themes.dark.bright], CUSTOM_DARK.bright);
    assert.equal(r.themes.dark.name, "fffdark");
    assert.equal(r.active, "light");
    assert.deepEqual(r.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("内联 > 文件 > 内置：内联 ansi 覆盖文件，未内联字段取自文件/内置", () => {
  const dir = tempPaletteDir(CUSTOM_DARK, THEMES.light);
  try {
    const inlineAnsi = [
      "#010101",
      "#020202",
      "#030303",
      "#040404",
      "#050505",
      "#060606",
      "#070707",
      "#080808",
    ];
    const r = resolveThemes({
      active: "dark",
      paletteDir: dir,
      palettes: { dark: { ansi: inlineAnsi } },
    });
    // 内联 ansi 生效；背景/前景未被内联 → 取文件值
    assert.deepEqual([...r.themes.dark.ansi], inlineAnsi);
    assert.equal(r.themes.dark.background, "#010203");
    assert.equal(r.themes.dark.foreground, "#040506");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非法内联（ansi 非 8 项 / 非法 hex）→ 回落文件并告警", () => {
  const dir = tempPaletteDir(CUSTOM_DARK, THEMES.light);
  try {
    const r = resolveThemes({
      active: "dark",
      paletteDir: dir,
      palettes: { dark: { ansi: ["#111", "#222", "#333"] } },
    });
    // 内联非 8 项 → 回落到文件调色板
    assert.deepEqual([...r.themes.dark.ansi], CUSTOM_DARK.ansi);
    assert.ok(
      r.warnings.some((w) => w.includes("内联 ansi")),
      `应有 ansi 告警：${JSON.stringify(r.warnings)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paletteDir 缺失 → 回退默认链并给出告警", () => {
  const missing = join(tmpdir(), "tui-theme-missing-" + Date.now());
  const r = resolveThemes({ paletteDir: missing } as unknown as TuiThemeConfig);
  // 文件找不着 → 内置兜底仍全量可用
  assert.equal(r.themes.dark.background, THEMES.dark.background);
  assert.ok(
    r.warnings.some((w) => w.includes("paletteDir 不存在")),
    `应有 paletteDir 告警：${JSON.stringify(r.warnings)}`,
  );
});

test("semantics 槽位引用：bright.0 / 字面 hex 覆盖并按最终调色板解析", () => {
  const r = resolveThemes({
    active: "dark",
    paletteDir: "",
    palettes: {
      dark: {
        semantics: {
          gray: "bright.0", // 引用内置 bright[0]
          border: "#012345", // 字面 hex 直接生效
          focus: "ansi.7", // 引用内置 ansi[7]
        },
      },
    },
  } as TuiThemeConfig);
  assert.equal(r.themes.dark.semantics.gray, THEMES.dark.bright[0]);
  assert.equal(r.themes.dark.semantics.border, "#012345");
  assert.equal(r.themes.dark.semantics.focus, THEMES.dark.ansi[7]);
  // 未覆盖槽位保留内置默认
  assert.equal(r.themes.dark.semantics.code, THEMES.dark.semantics.code);
});

test("非法 semantics 引用 → 保留默认并告警", () => {
  const r = resolveThemes({
    active: "dark",
    paletteDir: "",
    palettes: { dark: { semantics: { gray: "not-a-color" } } },
  } as TuiThemeConfig);
  assert.equal(r.themes.dark.semantics.gray, THEMES.dark.semantics.gray);
  assert.ok(
    r.warnings.some((w) => w.includes("semantics.gray 非法")),
    `应有 semantics 告警：${JSON.stringify(r.warnings)}`,
  );
});

test("active 非法值 → 回落 dark", () => {
  const r = resolveThemes({
    active: "neon",
    paletteDir: "",
  } as unknown as TuiThemeConfig);
  assert.equal(r.active, "dark");
});

test("normalizeConfig：theme 段形状归一化（非法字段剔除、active/paletteDir 保留）", () => {
  const cfg = normalizeConfig({
    theme: {
      active: "light",
      paletteDir: "",
      palettes: {
        dark: {
          file: "my-dark.json",
          ansi: ["x", 1, "#234567"], // 混合类型 → 整体剔除（非 string[])
          background: "#AABBCC",
          semantics: { gray: "bright.1", bad: 42 },
        },
      },
    },
  });
  assert.equal(cfg.theme?.active, "light");
  assert.equal(cfg.theme?.paletteDir, "");
  const dark = cfg.theme?.palettes?.dark;
  assert.equal(dark?.file, "my-dark.json");
  assert.equal(dark?.ansi, undefined, "混合类型 ansi 应剔除");
  assert.equal(dark?.background, "#AABBCC");
  assert.deepEqual(dark?.semantics, { gray: "bright.1" }, "非字符串语义剔除");
});

// ---------- 注册表 → 渲染器贯通（回归：防「注入的 themes 被静默忽略」） ----------
//
// resolveThemes 的产物必须真正抵达渲染层：注入 sentinel 语义色后，帧内 SGR 只能
// 出现 sentinel 值。否则自定义调色板会静默失效，而所有基于内置快照的断言仍全绿。

/** hex → "r;g;b"（SGR 片段用） */
function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${n >> 16};${(n >> 8) & 0xff};${n & 0xff}`;
}

/** sentinel 色（与内置 dark gray #80878E / light gray #475863 / 基底色均不同） */
const SENTINEL = {
  darkGray: "#0102AB",
  darkCode: "#0304CD",
  darkBg: "#0B0C0D",
  darkFg: "#0E0F10",
  lightGray: "#0506EF",
  lightCode: "#0708A1",
  lightBg: "#111213",
  lightFg: "#141516",
} as const;

/** 只走内联层的 sentinel 注册表（paletteDir:"" 禁用文件查找，不依赖机器环境） */
function sentinelThemes(): Record<ThemeId, ColorTheme> {
  return resolveThemes({
    active: "dark",
    paletteDir: "",
    palettes: {
      dark: {
        background: SENTINEL.darkBg,
        foreground: SENTINEL.darkFg,
        semantics: { gray: SENTINEL.darkGray, code: SENTINEL.darkCode },
      },
      light: {
        background: SENTINEL.lightBg,
        foreground: SENTINEL.lightFg,
        semantics: { gray: SENTINEL.lightGray, code: SENTINEL.lightCode },
      },
    },
  } as TuiThemeConfig).themes;
}

/** 一行两段：前景 gray + 背景 code（语义名由渲染层经实例主题解析） */
const SENTINEL_ROW: FrameRow[] = [
  {
    segments: [
      { text: "G", style: { fg: "gray" } },
      { text: "C", style: { bg: "code" } },
    ],
  },
];

test("注册表贯通 createRenderer({ themes })：注入语义色落到 SGR，内置色不漏出", () => {
  const themes = sentinelThemes();
  const out: string[] = [];
  const renderer = createRenderer({
    write: (s) => out.push(s),
    rawMode: false,
    exitOnClose: false,
    themes,
  });
  // 注册表可读回（注入未被吞掉）
  const injected = renderer.getTheme?.("dark");
  assert.ok(injected, "renderer.getTheme 应可用");
  assert.equal(injected.semantics.gray, SENTINEL.darkGray);
  for (const id of ["dark", "light"] as const) {
    renderer.setTheme(id);
    out.length = 0;
    renderer.refresh(SENTINEL_ROW);
    const ansi = out.join("");
    const gray = id === "dark" ? SENTINEL.darkGray : SENTINEL.lightGray;
    const code = id === "dark" ? SENTINEL.darkCode : SENTINEL.lightCode;
    assert.ok(
      ansi.includes(`38;2;${rgbOf(gray)}`),
      `${id} 前景应取注入 gray：${ansi.slice(0, 160)}`,
    );
    assert.ok(
      ansi.includes(`48;2;${rgbOf(code)}`),
      `${id} 背景应取注入 code：${ansi.slice(0, 160)}`,
    );
    // 基底前景/背景同样取注入注册表
    const bg = id === "dark" ? SENTINEL.darkBg : SENTINEL.lightBg;
    const fg = id === "dark" ? SENTINEL.darkFg : SENTINEL.lightFg;
    assert.ok(ansi.includes(`48;2;${rgbOf(bg)}`), `${id} 基底背景应取注入值`);
    assert.ok(ansi.includes(`38;2;${rgbOf(fg)}`), `${id} 基底前景应取注入值`);
    // 若渲染层回退到全局内置 THEMES，下面四条会命中
    assert.ok(
      !ansi.includes(rgbOf(THEMES[id].semantics.gray)),
      `${id} 不应漏出内置 gray`,
    );
    assert.ok(
      !ansi.includes(rgbOf(THEMES[id].semantics.code)),
      `${id} 不应漏出内置 code`,
    );
    assert.ok(
      !ansi.includes(rgbOf(THEMES[id].background)),
      `${id} 不应漏出内置基底背景`,
    );
    assert.ok(
      !ansi.includes(rgbOf(THEMES[id].foreground)),
      `${id} 不应漏出内置基底前景`,
    );
  }
  renderer.close();
});

test("注册表贯通 Screen({ themes })：setTheme 后帧内语义色与基底色均取注入值", () => {
  const out: string[] = [];
  const screen = new Screen({
    write: (s) => out.push(s),
    themes: sentinelThemes(),
  });
  screen.setTheme("dark");
  screen.render(SENTINEL_ROW);
  const ansi = out.join("");
  assert.ok(
    ansi.includes(`38;2;${rgbOf(SENTINEL.darkGray)}`),
    "前景取注入 gray",
  );
  assert.ok(
    ansi.includes(`48;2;${rgbOf(SENTINEL.darkCode)}`),
    "背景取注入 code",
  );
  assert.ok(
    ansi.includes(`48;2;${rgbOf(SENTINEL.darkBg)}`),
    "基底背景取注入值",
  );
  assert.ok(
    ansi.includes(`38;2;${rgbOf(SENTINEL.darkFg)}`),
    "基底前景取注入值",
  );
  // 基底前景/背景同样来自注入注册表（内置 dark 基底 #0A1127 不得出现）
  assert.ok(
    !ansi.includes(rgbOf(THEMES.dark.background)),
    "不应漏出内置基底背景",
  );
  assert.ok(
    !ansi.includes(rgbOf(THEMES.dark.foreground)),
    "不应漏出内置基底前景",
  );
});
