/**
 * 存量迁移（设计 §10）：**显式调用才执行**，不静默删、不备份。
 *
 * 当前只有一条路径——v1 单库（`knowledge.db`）清空重建：旧库内容无法判定归属
 * 且含凭据形态条目（2026-10-08 用户裁定），直接删除文件（不 `VACUUM INTO`、不留 `.bak`）。
 * schema 版本不匹配时 openKnowledgeDatabase 一律拒绝打开，重建只能经本模块。
 */

import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** 可识别的旧布局（目前只有 v1 单库）。 */
export type MigrateFrom = "v1";

/** 处置方式；`drop` = 直接删除（当前唯一形态）。 */
export type MigrateMode = "drop";

export interface MigrateInput {
  /** 旧库文件路径。 */
  dbPath: string;
  from: MigrateFrom;
  mode: MigrateMode;
}

export interface MigrateResult {
  /** 解析后的绝对路径。 */
  dbPath: string;
  /** 实际删除的文件（含 WAL 旁文件）；库不存在时为空数组。 */
  removed: string[];
}

/** SQLite 侧车文件后缀（预写日志 / 共享内存）。 */
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行一次存量迁移。幂等：库已不存在时返回空 `removed`，不报错。
 * 未实现的 `from` / `mode` 组合直接拒绝，避免「调用成功但什么都没做」。
 */
export async function migrate(input: MigrateInput): Promise<MigrateResult> {
  if (input.from !== "v1" || input.mode !== "drop") {
    throw new Error(
      `memory-base 不支持的迁移：from=${String(input.from)} mode=${String(input.mode)}（可用：from=v1, mode=drop）`,
    );
  }
  const dbPath = resolve(input.dbPath);
  const removed: string[] = [];
  const targets = [
    dbPath,
    ...SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`),
  ];
  for (const target of targets) {
    if (await fileExists(target)) {
      await rm(target, { force: true });
      removed.push(target);
    }
  }
  return { dbPath, removed };
}
