// src/app/config.ts — TUI 用户配置文件（tui.config.json）
//
// 布局尺寸配置（语义「总：目标」——比例类配置项为分母 divisor，目标=总数/divisor）：
//   - footerHeight:          交互区（输入框+按键提示）绝对行数（缺省自动：min(4,max(2,rows/5))）
//   - activityHeightDivisor: 活动区高 = floor(contentTopH / divisor)（缺省 2 ≈ 1/2）
//   - activityTopRow:        活动区分隔行锚定（"half" = 屏幕中线行 floor(rows/2)，或绝对行号；
//                            配置后替代 activityHeightDivisor 的比例分配，缺省 null = 走 divisor）
//   - statusColumnDivisor:   状态列宽 = floor(cols / divisor)（缺省 3 ≈ 1/3，历史区仍保底 10 列）
// 配置文件缺失/非法 → 全部回落默认（fail-safe，不崩溃）。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TuiLayoutConfig {
  /** 交互区绝对行数（输入框+按键提示；缺省自动 1/5 上限 4） */
  footerHeight?: number;
  /** 活动区高分母（contentTopH / divisor；1/2 → 2） */
  activityHeightDivisor?: number;
  /** 活动区分隔行锚定（"half" = floor(rows/2)，或绝对行号；配置后替代 divisor 比例，缺省走 divisor） */
  activityTopRow?: "half" | number;
  /** 状态列宽分母（cols / divisor；1/3 → 3） */
  statusColumnDivisor?: number;
}

export interface TuiNotifyConfig {
  /** 声音提醒总开关（任务结束 / 等待输入超阈值 → 终端 BEL）；缺省 true（即可用） */
  enabled?: boolean;
  /** 等待用户输入超过该阈值(ms)触发 bell；缺省 8000（8s） */
  idleThresholdMs?: number;
}

export interface TuiThemePaletteConfig {
  /** 调色板 JSON 文件名（paletteDir 目录内；缺省 fffdark.json/ffflight.json） */
  file?: string;
  /** 内联 8 槽位 ANSI 色（#RRGGBB；覆盖/替代文件读取） */
  ansi?: string[];
  /** 内联 8 槽位亮色（#RRGGBB） */
  bright?: string[];
  background?: string;
  foreground?: string;
  /** 语义色槽位覆盖：字面 #RRGGBB 或 "ansi.N"/"bright.N" 引用（合法性由 theme-config 校验） */
  semantics?: Record<string, string>;
}

export interface TuiThemeConfig {
  /** 启动默认主题（dark/light，非法回落 dark） */
  active: "dark" | "light";
  /** 调色板目录；"" 禁用文件查找；缺省走 $FFF_HOME → ~/fff 默认链 */
  paletteDir?: string;
  /** 各主题的调色板覆盖（内联 > paletteDir 文件 > 内置兜底） */
  palettes?: Partial<Record<"dark" | "light", TuiThemePaletteConfig>>;
}

export interface TuiConfig {
  layout?: TuiLayoutConfig;
  notify?: TuiNotifyConfig;
  /** 主题段（调色板解析见 renderer/theme-config.ts） */
  theme?: TuiThemeConfig;
}

const CFG_FILE = "tui.config.json";

/** 从当前模块目录向上逐级定位 tui.config.json（src/app 与 dist/src/app 层级不同，逐级兜底） */
function resolveConfigPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6 && dir !== dirname(dir); i++) {
    const candidate = join(dir, CFG_FILE);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(dir, CFG_FILE);
}
const DEFAULT_CFG_PATH = resolveConfigPath();

const intGe = (v: unknown, min: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.max(min, Math.floor(v))
    : undefined;

const boolOr = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

const isNonEmptyStr = (v: unknown): v is string =>
  typeof v === "string" && v !== "";

/** activityTopRow 归一化："half" 字面量 → "half"；非负有限数向下取整；其余（负数/非法）→ undefined */
const normalizeTopRow = (v: unknown): "half" | number | undefined => {
  if (v === "half") return "half";
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
    return Math.floor(v);
  }
  return undefined;
};

/** theme 段形状归一化（色值合法性校验由 renderer/theme-config.ts 承担） */
function normalizeThemeSection(raw: unknown): TuiThemeConfig {
  const r = (raw ?? {}) as {
    active?: unknown;
    paletteDir?: unknown;
    palettes?: unknown;
  };
  const out: TuiThemeConfig = {
    active: r.active === "light" ? "light" : "dark",
    palettes: {},
  };
  if (typeof r.paletteDir === "string") out.paletteDir = r.paletteDir;
  const pals = (r.palettes ?? {}) as Record<string, unknown>;
  for (const id of ["dark", "light"] as const) {
    const p = pals[id];
    if (p === null || typeof p !== "object" || Array.isArray(p)) continue;
    const po = p as Record<string, unknown>;
    const entry: TuiThemePaletteConfig = {};
    if (isNonEmptyStr(po.file)) entry.file = po.file;
    if (Array.isArray(po.ansi) && po.ansi.every((x) => typeof x === "string"))
      entry.ansi = po.ansi as string[];
    if (
      Array.isArray(po.bright) &&
      po.bright.every((x) => typeof x === "string")
    )
      entry.bright = po.bright as string[];
    if (isNonEmptyStr(po.background)) entry.background = po.background;
    if (isNonEmptyStr(po.foreground)) entry.foreground = po.foreground;
    if (
      po.semantics !== null &&
      typeof po.semantics === "object" &&
      !Array.isArray(po.semantics)
    ) {
      const sem: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        po.semantics as Record<string, unknown>,
      )) {
        if (isNonEmptyStr(v)) sem[k] = v;
      }
      entry.semantics = sem;
    }
    out.palettes![id] = entry;
  }
  return out;
}

/** 归一化用户配置：非法/越界字段回落默认（undefined=未配置） */
export function normalizeConfig(raw: unknown): TuiConfig {
  const r = (raw ?? {}) as {
    layout?: Record<string, unknown>;
    notify?: Record<string, unknown>;
    theme?: unknown;
  };
  const l = r.layout ?? {};
  const n = r.notify ?? {};
  return {
    layout: {
      ...(intGe(l.footerHeight, 1) === undefined
        ? {}
        : { footerHeight: intGe(l.footerHeight, 1) }),
      ...(intGe(l.activityHeightDivisor, 1) === undefined
        ? {}
        : { activityHeightDivisor: intGe(l.activityHeightDivisor, 1) }),
      ...(normalizeTopRow(l.activityTopRow) === undefined
        ? {}
        : { activityTopRow: normalizeTopRow(l.activityTopRow) }),
      ...(intGe(l.statusColumnDivisor, 1) === undefined
        ? {}
        : { statusColumnDivisor: intGe(l.statusColumnDivisor, 1) }),
    },
    // notify：非法值回落 undefined（各自回落默认行为）；idleThresholdMs 最小 1000
    notify: {
      ...(boolOr(n.enabled) === undefined
        ? {}
        : { enabled: boolOr(n.enabled) }),
      ...(intGe(n.idleThresholdMs, 1_000) === undefined
        ? {}
        : { idleThresholdMs: intGe(n.idleThresholdMs, 1_000) }),
    },
    theme: normalizeThemeSection(r.theme),
  };
}

/** 载入配置文件：缺失/读取失败/JSON 非法 → 默认（空配置） */
export function loadTuiConfig(path = DEFAULT_CFG_PATH): TuiConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return { layout: {} };
  }
}
