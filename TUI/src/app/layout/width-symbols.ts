// layout/width-symbols.ts — 「呈现不确定」符号列表落盘（profile 目录内）
//
// 只记**哪些码点值得实测**，不记宽度：宽度每次会话重新实测（内存表 `WIDTH_OVERRIDES`，
// 见 markdown.ts）——于是换终端 / tmux / 字体 / 字号都自动正确，不需要终端标识、不需要
// 按终端分文件（用户 2026-10-12 讨论定稿，取代原「终端探测 + 按终端分宽度表」方案）。
//   - 文件：`<profile 目录>/tui-width-symbols.json`；
//   - 内容：`{ "version": 1, "symbols": ["<码点 hex>", ...] }`（去重；顺序 = 最近出现靠后）；
//   - 不设上限、不淘汰（列表单调增长，靠「最近优先」决定启动预探测的顺序）；
//   - 读失败 / 损坏 / 版本不符 → 空列表（回落静态表，绝不阻塞启动）。
//
// 纯 IO 模块（不依赖布局/渲染层）。

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 列表文件名（profile 目录内固定名） */
export const WIDTH_SYMBOLS_FILE = "tui-width-symbols.json";

/** 列表格式版本（结构变化时递增，旧文件自动作废） */
const SYMBOLS_VERSION = 1;

/** 列表文件路径 */
export function widthSymbolsPath(profileDir: string): string {
  return join(profileDir, WIDTH_SYMBOLS_FILE);
}

/**
 * 读符号列表（码点数组，文件顺序 = 最近出现靠后）。缺失 / 损坏 / 版本不符 → 空数组；
 * 非字符串项、非法码点、重复项一律丢弃。
 */
export function readWidthSymbols(profileDir: string): number[] {
  let raw: string;
  try {
    raw = readFileSync(widthSymbolsPath(profileDir), "utf8");
  } catch {
    return []; // 首次运行/无权限：无列表可用
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; symbols?: unknown };
    if (parsed.version !== SYMBOLS_VERSION) return [];
    if (!Array.isArray(parsed.symbols)) return [];
    const out: number[] = [];
    const seen = new Set<number>();
    for (const item of parsed.symbols) {
      if (typeof item !== "string") continue;
      const cp = Number.parseInt(item, 16);
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) continue;
      if (seen.has(cp)) continue;
      seen.add(cp);
      out.push(cp);
    }
    return out;
  } catch {
    return []; // 损坏：按空列表处理（下次实测后覆盖重写）
  }
}

/**
 * 写符号列表（临时文件 + rename 原子替换，权限 0600）。重复与非法码点写入前丢弃；
 * 失败静默返回 false（落盘只是「下次启动的先验」，实测值当次已生效）。
 */
export function writeWidthSymbols(
  profileDir: string,
  codePoints: Iterable<number>,
): boolean {
  const symbols: string[] = [];
  const seen = new Set<number>();
  for (const cp of codePoints) {
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) continue;
    if (seen.has(cp)) continue;
    seen.add(cp);
    symbols.push(cp.toString(16));
  }
  const path = widthSymbolsPath(profileDir);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: SYMBOLS_VERSION, symbols })}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件不存在（首个写失败点即在此）：无需清理
    }
    return false;
  }
}
