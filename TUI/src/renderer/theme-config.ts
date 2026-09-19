// TUI/src/renderer/theme-config.ts — 主题调色板配置解析
//
// 解析优先级：内联 palettes.<id> → paletteDir/<file>.json（上游单一源）→ 内置兜底 THEMES。
// config.ts 只做形状归一化（不依赖 renderer）；本模块承担语义校验与逐字段回退：
//   - 色值必须 #RRGGBB；ansi/bright 必须 8 项（缺失/非法 → 回退下一级：内联非法 → 文件 → 内置）
//   - semantics 支持 "ansi.N" / "bright.N" 槽位引用与字面 hex
//   - paletteDir 解析链：配置值 → $FFF_HOME/config/terminal-colortheme → ~/fff/...；
//     空串 "paletteDir": "" 显式禁用文件查找
// 启动时调用一次（main.ts），结果注入 createRenderer({ themes })，不做热重载。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TuiThemeConfig, TuiThemePaletteConfig } from "../app/config.ts";
import {
  THEMES,
  type ColorTheme,
  type SemanticColorName,
  type ThemeId,
} from "./theme.ts";

/** 8 槽位 hex 元组（与 ColorTheme.ansi/bright 同形） */
type Hex8 = [string, string, string, string, string, string, string, string];

/** 解析结果：dark/light 双调色板 + 启动默认主题 + 收集的告警（改配置未生效时提示） */
export interface ResolvedThemes {
  themes: Record<ThemeId, ColorTheme>;
  active: ThemeId;
  warnings: string[];
}

const SEMANTIC_KEYS: SemanticColorName[] = ["gray", "border", "code", "focus"];
const FILE_NAMES: Record<ThemeId, string> = {
  dark: "fffdark.json",
  light: "ffflight.json",
};
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SLOT_RE = /^(ansi|bright)\.([0-7])$/;

/** "~/..." 展开为 home 绝对路径（其余原样返回） */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** paletteDir 候选链：配置值（若有）→ $FFF_HOME → ~/fff */
function dirCandidates(paletteDir: string | undefined): string[] {
  if (paletteDir === "") return [];
  const cands: string[] = [];
  if (paletteDir) cands.push(expandHome(paletteDir));
  const env = process.env.FFF_HOME;
  if (env) cands.push(join(env, "config", "terminal-colortheme"));
  cands.push(join(homedir(), "fff", "config", "terminal-colortheme"));
  return cands;
}

/** 取第一个存在的目录；配置的显式目录缺失时记告警后继续默认链 */
function resolvePaletteDir(
  cfg: TuiThemeConfig | undefined,
  warnings: string[],
): string | null {
  for (const c of dirCandidates(cfg?.paletteDir)) {
    if (existsSync(c)) return c;
    if (cfg?.paletteDir && expandHome(cfg.paletteDir) === c) {
      warnings.push("theme: 配置的 paletteDir 不存在，回退默认查找链");
    }
  }
  return null;
}

/** 读取调色板目录下的主题 JSON；缺失/非法 JSON → null */
function parseFile(
  dir: string,
  id: ThemeId,
  file: string | undefined,
): Record<string, unknown> | null {
  const p = join(dir, file ?? FILE_NAMES[id]);
  if (!existsSync(p)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(p, "utf8"));
    return v !== null && typeof v === "object"
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type PaletteField = "ansi" | "bright" | "background" | "foreground";
type FieldValue = string | string[];

const hexOk = (v: FieldValue): boolean =>
  typeof v === "string" && HEX_RE.test(v);
const arr8Ok = (v: FieldValue): boolean =>
  Array.isArray(v) &&
  v.length === 8 &&
  v.every((h) => typeof h === "string" && HEX_RE.test(h as string));

/** semantics 槽位引用解析：字面 hex 或 "ansi.N"/"bright.N"（按最终 ansi/bright 解析） */
function slotToHex(
  ref: string | undefined,
  ansi: Hex8,
  bright: Hex8,
): string | null {
  if (!ref) return null;
  if (HEX_RE.test(ref)) return ref;
  const m = SLOT_RE.exec(ref);
  if (!m) return null;
  const arr = m[1] === "ansi" ? ansi : bright;
  return arr[Number(m[2])] ?? null;
}

/** 单主题解析：内联 > 文件 > 内置，逐字段回退（内联非法 → 文件 → 内置）并收集告警 */
function resolveTheme(
  id: ThemeId,
  override: TuiThemePaletteConfig | undefined,
  dir: string | null,
  warnings: string[],
): ColorTheme {
  const base = THEMES[id];
  const warn = (msg: string): void => {
    warnings.push(`theme ${id}: ${msg}`);
  };
  const inline = override ?? {};

  // 文件层（仅目录可用时尝试；默认文件名 fffdark.json/ffflight.json）
  let file: Record<string, unknown> | null = null;
  if (dir) {
    file = parseFile(dir, id, inline.file);
    if (!file && inline.file) warn(`paletteDir 中找不到 ${inline.file}`);
  } else if (inline.file) {
    warn(`paletteDir 未配置，忽略 file=${inline.file}`);
  }

  /** 取首个合法字段值：内联（非法则告警并跳过）→ 文件 → 内置兜底 */
  const fieldValid = (
    field: PaletteField,
    valid: (v: FieldValue) => boolean,
    label: string,
  ): FieldValue => {
    const iv = inline[field];
    if (iv !== undefined) {
      if (valid(iv)) return iv;
      warn(`内联 ${label} 缺失或非法，回退下一级`);
    }
    const fv = file?.[field];
    if (
      (typeof fv === "string" || Array.isArray(fv)) &&
      valid(fv as FieldValue)
    ) {
      return fv as FieldValue;
    }
    return base[field];
  };

  const ansi = fieldValid("ansi", arr8Ok, "ansi") as Hex8;
  const bright = fieldValid("bright", arr8Ok, "bright") as Hex8;
  const background = fieldValid("background", hexOk, "background") as string;
  const foreground = fieldValid("foreground", hexOk, "foreground") as string;

  // 语义槽位：内置默认打底，内联 semantics 逐槽覆盖（slot 引用按最终调色板解析）
  const semantics = { ...base.semantics };
  if (inline.semantics) {
    for (const key of SEMANTIC_KEYS) {
      const ref = inline.semantics[key];
      const value = slotToHex(ref, ansi, bright);
      if (value) semantics[key] = value;
      else if (ref !== undefined) {
        warn(
          `semantics.${key} 非法（需 #RRGGBB 或 ansi.N/bright.N），保留默认`,
        );
      }
    }
  }

  const name =
    typeof file?.name === "string" && file.name !== "" ? file.name : base.name;
  return { name, ansi, bright, background, foreground, semantics };
}

/** 按配置解析 dark/light 调色板与启动默认主题；配置缺失/非法一律回落，不抛异常 */
export function resolveThemes(cfg: TuiThemeConfig | undefined): ResolvedThemes {
  const warnings: string[] = [];
  const active: ThemeId = cfg?.active === "light" ? "light" : "dark";
  const dir = resolvePaletteDir(cfg, warnings);
  return {
    themes: {
      dark: resolveTheme("dark", cfg?.palettes?.dark, dir, warnings),
      light: resolveTheme("light", cfg?.palettes?.light, dir, warnings),
    },
    active,
    warnings,
  };
}
