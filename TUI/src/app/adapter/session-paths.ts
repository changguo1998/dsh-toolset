// app/adapter/session-paths.ts — 持久化会话目录定位（会话根 / id 白名单 / <slug>/<id> 查找）
//
// 从 dsh.ts 抽出，供「会话目录删除」与「TUI 侧会话状态快照（tui-state.json）」共用；
// dsh.ts 仍原样再导出 `isSafeSessionId` / `sessionRoots`（外部 import 路径不变）。

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/** 会话 id 必须是单段安全路径段（UUID / tui-<uuid> / session-<uuid>）：
 *  白名单与官方 dsh-tui 一致（仅字母数字与 `_`/`-`），分隔符与点段自然被拒 */
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

/**
 * 会话存储根目录（顺序与官方 dsh-tui sessionsRoots 一致）：
 * DSH_TUI_SESSION_ROOT → $DSH_HOME（缺省 ~/.dsh）/sessions → ~/.dsh-tui/sessions。
 */
export function sessionRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const roots: string[] = [];
  const override = env.DSH_TUI_SESSION_ROOT?.trim();
  if (override) roots.push(override);
  const dshHome = env.DSH_HOME?.trim();
  roots.push(join(dshHome ? dshHome : join(home, ".dsh"), "sessions"));
  roots.push(join(home, ".dsh-tui", "sessions"));
  return [...new Set(roots)];
}

/** 会话目录定位结果：ok=true 时 path 为 realpath 解析后的会话目录（防符号链接逃逸） */
export type SessionDirLookup =
  { ok: true; path: string } | { ok: false; reason: string };

/**
 * 各根下按 `<project-slug>/<id>` 定位持久化会话目录（首个命中根生效）。
 * 安全线：单段 id 白名单校验 → realpath 包含性校验（根或会话目录为指向根外的
 * 符号链接 → 跳过，不返回）。未找到 → 失败。
 */
export function locateSessionDir(
  id: string,
  roots: readonly string[] = sessionRoots(),
): SessionDirLookup {
  if (!isSafeSessionId(id)) {
    return { ok: false, reason: "会话 id 非法" };
  }
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(realRoot);
    } catch {
      continue;
    }
    for (const entry of entries) {
      let real: string;
      try {
        real = realpathSync(join(realRoot, entry, id));
      } catch {
        continue; // 该 slug 下无此会话目录
      }
      // 包含性校验：解析后必须仍在根内（防符号链接越界）
      if (!real.startsWith(realRoot + sep)) continue;
      return { ok: true, path: real };
    }
  }
  return { ok: false, reason: "未找到该会话的持久化目录" };
}
