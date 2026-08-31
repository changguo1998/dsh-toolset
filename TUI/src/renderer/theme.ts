// renderer/theme.ts — TUI 主题：内嵌 ~/fff/config/terminal-colortheme 的两份配色
// (fffdark=dark / ffflight=light) 作默认浅深色模式。
//
// 终端 16 色槽位映射：black..white → ansi[]，brightBlack..brightWhite → bright[]，
// gray 语义 = brightBlack(bright[0])。background/foreground 为终端基底色，
// 由 Screen 在帧首设置，保证切换浅色主题后常规文本仍可读。
// 刻意不做模块级可变主题：主题经 Screen.setTheme 持有，避免全局状态。
// 颜色一律 manual ANSI truecolor（不用 chalk）：chalk 单色段以 `39m` 收尾
// 会复位到终端默认前景而非当前主题基底前景，浅色主题下不可读。

export type ThemeId = "dark" | "light";

/** 与 fff terminal-colortheme JSON 同构（[ansi[8], bright[8]] 元组） */
export interface ColorTheme {
  name: string;
  ansi: [string, string, string, string, string, string, string, string];
  bright: [string, string, string, string, string, string, string, string];
  background: string;
  foreground: string;
}

export const DEFAULT_THEME: ThemeId = "dark";

/** 严格解析外部配置值：仅接受 dark/light，否则退回默认 dark */
export function normalizeThemeId(value: unknown): ThemeId {
  return value === "light" ? "light" : "dark"; // dark 兜底（含非法值）
}

/** 内嵌 ~/fff/config/terminal-colortheme/fffdark.json / ffflight.json */
export const THEMES: Record<ThemeId, ColorTheme> = {
  dark: {
    name: "fffdark",
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
  },
  light: {
    name: "ffflight",
    ansi: [
      "#000000",
      "#C5225E",
      "#50A74E",
      "#C5984E",
      "#4032D3",
      "#B622D3",
      "#40A7C3",
      "#F4F4F4",
    ],
    bright: [
      "#555555",
      "#EE6DA4",
      "#96D099",
      "#EEC499",
      "#8B78FC",
      "#E26DFC",
      "#8BD0F0",
      "#FFFFFF",
    ],
    background: "#DFE3F8",
    foreground: "#555555",
  },
};

/** 可主题化的颜色名（chalk 常用子集，gray = brightBlack） */
export type ColorName =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

const BASE_SLOTS: Record<string, number> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
};

/** 颜色名 → 主题调色板十六进制；不认识返回 null */
export function ansiNameToHex(theme: ColorTheme, name: string): string | null {
  if (name === "gray") return theme.bright[0];
  const bright = name.startsWith("bright");
  const base = (bright ? name.slice("bright".length) : name).toLowerCase();
  const idx = BASE_SLOTS[base];
  if (idx === undefined) return null;
  return (bright ? theme.bright[idx] : theme.ansi[idx]) ?? null;
}

/** hex 转 truecolor SGR（fg=true 前景 38;2；否则背景 48;2；不识别原样返回空串） */
export function hexSgr(hex: string, fg: boolean): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return "";
  const n = parseInt(m[1]!, 16);
  const r = n >> 16;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `\x1b[${fg ? 38 : 48};2;${r};${g};${b}m`;
}

/** 主题化上色函数：前景 SGR + 文本 + 恢复主题基底前景（manual ANSI，不用 chalk） */
export function colorFor(
  themeId: ThemeId,
  name: ColorName,
): (s: string) => string {
  const t = THEMES[themeId];
  const hex = ansiNameToHex(t, name);
  if (!hex) return (s) => s;
  const open = hexSgr(hex, true);
  const close = hexSgr(t.foreground, true);
  return (s) => open + s + close;
}

/** 主题基底前景/背景转 SGR（Screen 帧首设置用） */
export function themeSgr(theme: ColorTheme, fg: boolean): string {
  return hexSgr(fg ? theme.foreground : theme.background, fg);
}
