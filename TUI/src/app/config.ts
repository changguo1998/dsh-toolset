// src/app/config.ts — TUI 用户配置文件（tui.config.json）
//
// 布局尺寸配置（语义「总：目标」——比例类配置项为分母 divisor，目标=总数/divisor）：
//   - footerHeight:          交互区（输入框+按键提示）绝对行数（缺省自动：min(4,max(2,rows/5))）
//   - activityHeightDivisor: 活动区高 = floor(contentTopH / divisor)（缺省 2 ≈ 1/2）
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
  /** 状态列宽分母（cols / divisor；1/3 → 3） */
  statusColumnDivisor?: number;
}

export interface TuiConfig {
  layout?: TuiLayoutConfig;
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

/** 归一化用户配置：非法/越界字段回落默认（undefined=未配置） */
export function normalizeConfig(raw: unknown): TuiConfig {
  const r = (raw ?? {}) as { layout?: Record<string, unknown> };
  const l = r.layout ?? {};
  return {
    layout: {
      ...(intGe(l.footerHeight, 1) === undefined
        ? {}
        : { footerHeight: intGe(l.footerHeight, 1) }),
      ...(intGe(l.activityHeightDivisor, 1) === undefined
        ? {}
        : { activityHeightDivisor: intGe(l.activityHeightDivisor, 1) }),
      ...(intGe(l.statusColumnDivisor, 1) === undefined
        ? {}
        : { statusColumnDivisor: intGe(l.statusColumnDivisor, 1) }),
    },
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
