// layout/width-table.ts — 实测宽度表落盘（profile 目录内）
//
// 运行时按需实测得到的「呈现不确定」字符宽度（见 markdown.ts 的 isWidthUncertainChar）
// 落盘复用，避免每个会话重测：
//   - 文件：`<profile 目录>/tui-width-table.json`（用户 2026-10-01 裁定，见 BACKLOG
//     「字符宽度表：运行时按需实测 + 落盘到 profile」）；
//   - 内容：`{ "version": 1, "term": "TERM|TERM_PROGRAM|COLORTERM", "widths": { "<码点 hex>": 1|2 } }`；
//   - term 不匹配 → 整表作废（换终端/字体后旧值不可信，重测）。
//
// 纯 IO 模块（不依赖布局/渲染层）；任何读写失败静默回落静态表，不影响排版与启动。

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 表文件名（profile 目录内固定名；终端区分靠文件内的 term 字段，不靠文件名） */
export const WIDTH_TABLE_FILE = "tui-width-table.json";

/** 表格式版本（结构变化时递增，旧文件自动作废） */
const TABLE_VERSION = 1;

/** 表文件路径 */
export function widthTablePath(profileDir: string): string {
  return join(profileDir, WIDTH_TABLE_FILE);
}

/**
 * 当前终端标识：`TERM|TERM_PROGRAM|COLORTERM` 拼接。同一 profile 被不同终端/字体
 * 复用时宽度实测值不可信，故仅按相等性比较，不参与文件名。
 */
export function terminalKey(env: NodeJS.ProcessEnv = process.env): string {
  return [env.TERM ?? "", env.TERM_PROGRAM ?? "", env.COLORTERM ?? ""].join(
    "|",
  );
}

/**
 * 读取实测宽度表：文件缺失 / 损坏 / 版本或终端标识不匹配 → 空表（调用方回落静态表）。
 * 只接受 1 或 2 列的值，其余条目丢弃。
 */
export function readWidthTable(
  profileDir: string,
  term: string,
): Map<string, number> {
  const out = new Map<string, number>();
  let raw: string;
  try {
    raw = readFileSync(widthTablePath(profileDir), "utf8");
  } catch {
    return out; // 首次运行/无权限：无表可读
  }
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      term?: unknown;
      widths?: unknown;
    };
    if (parsed.version !== TABLE_VERSION || parsed.term !== term) return out;
    if (typeof parsed.widths !== "object" || parsed.widths === null) return out;
    for (const [hex, width] of Object.entries(
      parsed.widths as Record<string, unknown>,
    )) {
      if (width !== 1 && width !== 2) continue;
      const cp = Number.parseInt(hex, 16);
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) continue;
      out.set(String.fromCodePoint(cp), width);
    }
  } catch {
    return new Map(); // 损坏：按空表处理（下次实测后覆盖重写）
  }
  return out;
}

/**
 * 写入实测宽度表（临时文件 + rename 原子替换，权限 0600）。失败静默返回 false
 * （排版已按实测值生效，落盘只是复用手段）。
 */
export function writeWidthTable(
  profileDir: string,
  term: string,
  entries: Iterable<readonly [string, number]>,
): boolean {
  const widths: Record<string, number> = {};
  for (const [ch, width] of entries) {
    if (width !== 1 && width !== 2) continue;
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    widths[cp.toString(16)] = width;
  }
  const path = widthTablePath(profileDir);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: TABLE_VERSION, term, widths })}\n`,
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
