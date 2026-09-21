// src/app/config.ts — TUI 用户配置文件（tui.config.json）
//
// 布局尺寸配置（语义「总：目标」——比例类配置项为分母 divisor，目标=总数/divisor）：
//   - footerHeight:          交互区（输入框+按键提示）绝对行数（缺省自动：min(4,max(2,rows/5))）
//   - activityHeightDivisor: 活动区高 = floor(contentTopH / divisor)（缺省 2 ≈ 1/2）
//   - activityTopRow:        活动区分隔行锚定（"half" = 屏幕中线行 floor(rows/2)，或绝对行号；
//                            配置后替代 activityHeightDivisor 的比例分配，缺省 null = 走 divisor）
//   - statusColumnDivisor:   状态列宽 = floor(cols / divisor)（缺省 3 ≈ 1/3，历史区仍保底 10 列）
//   - activityPlacement:     活动区排列方式（缺省 "vertical" 恒上下）：
//                             "auto" = 按黄金分割比自动在上下/左右间选择，使分割后各 pane
//                             的宽高比尽量接近 φ；"horizontal" = 固定左右并排。
//                             左右排列时活动区宽 = floor(左列正文宽 / activityHeightDivisor)，
//                             两侧各保底 20 列（不足则回落上下），activityTopRow 不再生效。
// 会话维护段：
//   - session.autoCleanEmpty: 启动时自动清理空会话（持久化+非 live+非当前+无用户消息），
//                             缺省 false（关闭）；开启后 start() 后台删除并 notice 汇报
// 配置文件缺失/非法 → 全部回落默认（fail-safe，不崩溃）。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SymbolRulesConfig } from "./symbols.ts";

export interface TuiLayoutConfig {
  /** 交互区绝对行数（输入框+按键提示；缺省自动 1/5 上限 4） */
  footerHeight?: number;
  /** 活动区高分母（contentTopH / divisor；1/2 → 2） */
  activityHeightDivisor?: number;
  /** 活动区分隔行锚定（"half" = floor(rows/2)，或绝对行号；配置后替代 divisor 比例，缺省走 divisor） */
  activityTopRow?: "half" | number;
  /** 活动区排列方式（缺省 "vertical"）："auto" 按黄金分割比自动选上下/左右，"horizontal" 固定左右 */
  activityPlacement?: ActivityPlacement;
  /** 状态列宽分母（cols / divisor；1/3 → 3） */
  statusColumnDivisor?: number;
}

/** 活动区排列方式（layout.activityPlacement）：auto = 按黄金比自动选；其余固定 */
export type ActivityPlacement = "auto" | "vertical" | "horizontal";

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

export interface TuiSessionConfig {
  /** 启动时自动清理空会话（持久化 + 非 live + 非当前 + 无用户消息）；缺省 false（关闭） */
  autoCleanEmpty?: boolean;
}

export interface TuiConfig {
  layout?: TuiLayoutConfig;
  notify?: TuiNotifyConfig;
  /** 主题段（调色板解析见 renderer/theme-config.ts） */
  theme?: TuiThemeConfig;
  /** 会话维护段（启动自动清理空会话等） */
  session?: TuiSessionConfig;
  /** 模型输出符号规范化段（推荐列表/别名映射/是否提醒模型，见 src/app/symbols.ts） */
  symbols?: SymbolRulesConfig;
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

/** activityPlacement 归一化：仅接受三个字面量；其余（非法）→ undefined（回落 vertical） */
const normalizePlacement = (v: unknown): ActivityPlacement | undefined =>
  v === "auto" || v === "vertical" || v === "horizontal" ? v : undefined;

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
    session?: Record<string, unknown>;
    symbols?: Record<string, unknown>;
  };
  const l = r.layout ?? {};
  const n = r.notify ?? {};
  const s = r.session ?? {};
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
      ...(normalizePlacement(l.activityPlacement) === undefined
        ? {}
        : { activityPlacement: normalizePlacement(l.activityPlacement) }),
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
    // session：非法值回落 undefined（各自回落默认；autoCleanEmpty 非法 → 关闭）
    session: {
      ...(boolOr(s.autoCleanEmpty) === undefined
        ? {}
        : { autoCleanEmpty: boolOr(s.autoCleanEmpty) }),
    },
    symbols: normalizeSymbolsSection(r.symbols),
  };
}

/** 归一化 symbols 段：recommended（字符串数组）/ aliases（非空字符串映射）/ warnModel（布尔）。 */
function normalizeSymbolsSection(raw: unknown): SymbolRulesConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  const recommended = Array.isArray(s.recommended)
    ? s.recommended.filter(
        (x): x is string => typeof x === "string" && x !== "",
      )
    : undefined;
  let aliases: Record<string, string> | undefined;
  if (typeof s.aliases === "object" && s.aliases !== null) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.aliases as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") out[k] = v;
    }
    if (Object.keys(out).length > 0) aliases = out;
  }
  const warnModel = boolOr(s.warnModel);
  if (!recommended && !aliases && warnModel === undefined) return undefined;
  return {
    ...(recommended ? { recommended } : {}),
    ...(aliases ? { aliases } : {}),
    ...(warnModel === undefined ? {} : { warnModel }),
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
