// renderer/theme.ts — TUI 主题：内置兜底调色板 + 语义色槽位
//
// 调色板配置化（tui.config.json theme 段，见 theme-config.ts）：
//   解析优先级 = 内联 palettes.<id> → paletteDir/<file>.json（上游单一源，
//   默认 ~/fff/config/terminal-colortheme）→ 本文件的 THEMES 内置兜底。
// 本文件只承载「内置兜底快照」；启动时由 theme-config.ts 按配置解析后，
// 把解析结果注入 renderer（createRenderer({ themes })）。
//
// 终端 16 色槽位映射：black..white → ansi[]，brightBlack..brightWhite → bright[]。
// 语义色槽位（gray/border/code/focus）一律从 ColorTheme.semantics 取 hex，
// 不再按主题 name 或 themeId 推断（旧实现按 theme.name==="fffdark" 分支，
// 自定义配色会静默走错分支）。三语义色槽位定位：
//   次要文字 gray   = dark bright[0] #80878E / light bright[0] #475863
//   边框 border     = ansi[4]（dark #5A98F3 / light #1256B2）
//   行内代码 code   = ansi[0]（dark #272336）/ ansi[7]（light #E9EBEE，米色底可读）
//   焦点框 focus    = dark bright[7] #FFFFFF / light ansi[0] #121418
// 两主题同语义槽位色值不同，表述必须带槽位+双主题值。
// 颜色一律 manual ANSI truecolor（不用 chalk）：chalk 单色段以 `39m` 收尾
// 会复位到终端默认前景而非当前主题基底前景，浅色主题下不可读。

export type ThemeId = "dark" | "light";

/** 语义色槽位名（排版层只携带这些名字，取色由渲染层经 semantics 解析） */
export type SemanticColorName = "gray" | "border" | "code" | "focus";

/** 与 fff terminal-colortheme JSON 同构（[ansi[8], bright[8]] 元组 + 语义槽位） */
export interface ColorTheme {
  name: string;
  ansi: [string, string, string, string, string, string, string, string];
  bright: [string, string, string, string, string, string, string, string];
  background: string;
  foreground: string;
  /** 语义色槽位 → 已解析 hex（theme-config 解析 "ansi.N"/"bright.N" 引用） */
  semantics: Record<SemanticColorName, string>;
}

export const DEFAULT_THEME: ThemeId = "dark";

/** 严格解析外部配置值：仅接受 dark/light，否则退回默认 dark */
export function normalizeThemeId(value: unknown): ThemeId {
  return value === "light" ? "light" : "dark"; // dark 兜底（含非法值）
}

/** 内置兜底调色板（= 当前 ~/fff/config/terminal-colortheme 快照；可被配置整体替换） */
export const THEMES: Record<ThemeId, ColorTheme> = {
  dark: {
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
      code: "#272336", // ansi.0（旧硬编码 #434343 已随新配色改为槽位引用）
      focus: "#FFFFFF", // bright.7
    },
  },
  light: {
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
      gray: "#475863", // bright.0（旧按 ansi[7] #F4F4F4，新配色下与米色底近同色）
      border: "#1256B2", // ansi.4
      code: "#E9EBEE", // ansi.7（旧 #E8E8E8；ansi.0 是近黑会成刺眼黑块）
      focus: "#121418", // ansi.0
    },
  },
};

/** 可主题化的颜色名（chalk 常用子集 + 语义槽位；gray/border/code/focus 由 semantics 解析） */
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
  | "border"
  | "code"
  | "focus"
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
  // 语义色槽位（数据驱动：不再按主题 name 分支）
  const semantic = theme.semantics[name as SemanticColorName];
  if (semantic !== undefined) return semantic;
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

/** 主题基底前景/背景转 SGR（Screen 帧首设置用） */
export function themeSgr(theme: ColorTheme, fg: boolean): string {
  return hexSgr(fg ? theme.foreground : theme.background, fg);
}
