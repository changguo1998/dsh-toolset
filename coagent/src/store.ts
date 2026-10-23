/**
 * src/store.ts — coagent 的状态落盘：索引原子读写、每记录一目录、配额裁剪与墓碑。
 *
 * 落点（决策项 11）：`<父会话目录>/coagent/`（目录 0700）；
 * 索引 `index.json` 用 tmp + rename 原子写（0600），记录目录 `<coagent_id>/` 放
 * `meta.json` / `claim.log` / `screen.log`。`maxRecords` 超出时删最老的终态目录，索引里把
 * 记录标成 `pruned`（墓碑），便于 `list` 解释「为什么少了一条」。
 *
 * 并发：同一 store 实例内的读改写经 `update()` 串行（进程内唯一写入者）；跨进程并发写同一
 * 会话目录不在本包承诺内（同一父会话只有一个 dsh 进程）。
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { TERMINAL_STATES } from "./types.ts";
import type { CoagentIndex, CoagentRecord } from "./types.ts";

/** 索引文件名（固定；记录目录里同名文件不存在）。 */
export const INDEX_FILE = "index.json";
/** 记录快照文件名。 */
export const META_FILE = "meta.json";
/** 认领轮询摘要文件名。 */
export const CLAIM_LOG = "claim.log";
/** 失败屏摘要文件名。 */
export const SCREEN_LOG = "screen.log";

/** 存储层错误（读坏 / 写失败）；动作层统一转 `record_write_failed` 或 `session_paths_unavailable`。 */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/** 会话目录推导失败（`sessionPaths.sessionDirFor` 抛错）→ 动作层转 `session_paths_unavailable`。 */
export class PathsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathsUnavailableError";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 空索引。 */
export function emptyIndex(): CoagentIndex {
  return { version: 1, records: {} };
}

/** 最小形状校验（索引被手改 / 截断时不静默接受）。 */
export function isIndex(value: unknown): value is CoagentIndex {
  if (typeof value !== "object" || value === null) return false;
  const index = value as Partial<CoagentIndex>;
  if (index.version !== 1) return false;
  if (typeof index.records !== "object" || index.records === null) return false;
  for (const record of Object.values(index.records)) {
    if (typeof record !== "object" || record === null) return false;
    const r = record as unknown as Record<string, unknown>;
    if (typeof r["coagent_id"] !== "string") return false;
    if (typeof r["state"] !== "string") return false;
    if (typeof r["cwd"] !== "string") return false;
    if (typeof r["started_at"] !== "number") return false;
    if (typeof r["updated_at"] !== "number") return false;
  }
  return true;
}

/**
 * 计算要裁剪的记录：记录数（不含墓碑）超过上限时，按 `updated_at` 从旧到新删**终态**记录。
 * 全是非终态时不动（`maxLive` 已挡住并行上限）。
 */
export function recordsToPrune(
  index: CoagentIndex,
  maxRecords: number,
): CoagentRecord[] {
  let active = Object.values(index.records).filter(
    (record) => record.pruned !== true,
  );
  const victims: CoagentRecord[] = [];
  while (active.length > maxRecords) {
    const terminal = active
      .filter((record) => TERMINAL_STATES.includes(record.state))
      .sort((a, b) => a.updated_at - b.updated_at);
    const victim = terminal[0];
    if (victim === undefined) break;
    victim.pruned = true;
    victims.push(victim);
    active = active.filter((record) => record.coagent_id !== victim.coagent_id);
  }
  return victims;
}

/** 记录目录里的附属文件（都可缺省；给了就覆盖写）。 */
export interface RecordArtifacts {
  meta?: CoagentRecord;
  claimLog?: string;
  screen?: string;
}

/** 文件存储：一个父会话一个目录，索引 + 每记录一目录。 */
export class FileCoagentStore {
  /** coagent 根目录（`<父会话目录>/coagent/` 或降级目录）。 */
  readonly root: string;
  readonly #maxRecords: number;
  /** 索引读改写队列（进程内串行）。 */
  #queue: Promise<void> = Promise.resolve();

  constructor(root: string, options: { maxRecords?: number } = {}) {
    this.root = root;
    this.#maxRecords = options.maxRecords ?? 50;
  }

  /** 索引文件绝对路径（排障与用例断言用）。 */
  get indexPath(): string {
    return join(this.root, INDEX_FILE);
  }

  /** 某条记录的目录。 */
  recordDir(coagentId: string): string {
    return join(this.root, coagentId);
  }

  /** 读索引；不存在返回空索引，形状不符抛 `StoreError`。 */
  async read(): Promise<CoagentIndex> {
    let text: string;
    try {
      text = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyIndex();
      }
      throw new StoreError(
        `读取索引失败（${this.indexPath}）：${describe(error)}`,
      );
    }
    return parseIndex(text, this.indexPath);
  }

  /** 同步读（退出钩子用；不能 await）。 */
  readSync(): CoagentIndex {
    let text: string;
    try {
      text = readFileSync(this.indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyIndex();
      }
      throw new StoreError(
        `读取索引失败（${this.indexPath}）：${describe(error)}`,
      );
    }
    return parseIndex(text, this.indexPath);
  }

  /**
   * 串行读改写：`fn` 原地改索引，返回后裁剪 + 原子写盘。
   * 返回 `{ index, result }`（`result` 是 `fn` 的返回值，便于把「本次新增的记录」带出去）。
   */
  async update<T>(
    fn: (index: CoagentIndex) => T | Promise<T>,
  ): Promise<{ index: CoagentIndex; result: T }> {
    const run = async (): Promise<{
      index: CoagentIndex;
      result: T;
    }> => {
      const index = await this.read();
      const result = await fn(index);
      await this.save(index);
      return { index, result };
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 裁剪 + 原子写索引；被裁剪记录的目录一并删除。 */
  async save(index: CoagentIndex): Promise<void> {
    const victims = recordsToPrune(index, this.#maxRecords);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.#writeJson(this.indexPath, index);
    for (const victim of victims) {
      await this.removeRecordDir(victim.coagent_id);
    }
  }

  /** 同步写（退出钩子用）：同样裁剪，但删目录走同步 IO。 */
  saveSync(index: CoagentIndex): void {
    const victims = recordsToPrune(index, this.#maxRecords);
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      this.#writeJsonSync(this.indexPath, index);
    } catch (error) {
      throw new StoreError(
        `写索引失败（${this.indexPath}）：${describe(error)}`,
      );
    }
    for (const victim of victims) {
      try {
        rmSync(this.recordDir(victim.coagent_id), {
          recursive: true,
          force: true,
        });
      } catch {
        /* 墓碑已落盘；目录删不掉不影响下次启动 */
      }
    }
  }

  /** 写记录目录里的文件（meta 必写；claim / screen 给了才写）。 */
  async writeArtifacts(
    coagentId: string,
    artifacts: RecordArtifacts,
  ): Promise<void> {
    const dir = this.recordDir(coagentId);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (artifacts.meta !== undefined) {
        await this.#writeJson(join(dir, META_FILE), artifacts.meta);
      }
      if (artifacts.claimLog !== undefined) {
        await writeFile(join(dir, CLAIM_LOG), artifacts.claimLog, {
          mode: 0o600,
        });
      }
      if (artifacts.screen !== undefined) {
        await writeFile(join(dir, SCREEN_LOG), artifacts.screen, {
          mode: 0o600,
        });
      }
    } catch (error) {
      throw new StoreError(`写记录目录失败（${dir}）：${describe(error)}`);
    }
  }

  /** 同步写记录目录（退出钩子用；只写 meta，claim / screen 留给正常路径）。 */
  writeArtifactsSync(coagentId: string, artifacts: RecordArtifacts): void {
    const dir = this.recordDir(coagentId);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (artifacts.meta !== undefined) {
        this.#writeJsonSync(join(dir, META_FILE), artifacts.meta);
      }
    } catch (error) {
      throw new StoreError(`写记录目录失败（${dir}）：${describe(error)}`);
    }
  }

  /** 记录目录是否存在。 */
  async hasRecordDir(coagentId: string): Promise<boolean> {
    try {
      const info = await stat(this.recordDir(coagentId));
      return info.isDirectory();
    } catch {
      return false;
    }
  }

  /** 删记录目录；返回是否真的删掉了东西（幂等）。 */
  async removeRecordDir(coagentId: string): Promise<boolean> {
    const existed = await this.hasRecordDir(coagentId);
    try {
      await rm(this.recordDir(coagentId), { recursive: true, force: true });
    } catch (error) {
      throw new StoreError(
        `删记录目录失败（${this.recordDir(coagentId)}）：${describe(error)}`,
      );
    }
    return existed;
  }

  async #writeJson(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.tmp-${randomUUID()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tmp, file);
      // 已存在的文件权限不受 mode 影响，显式补一次（0600 含时间线等排障信息）。
      await chmodIfPossible(file, 0o600);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new StoreError(`原子写失败（${file}）：${describe(error)}`);
    }
  }

  #writeJsonSync(file: string, value: unknown): void {
    const tmp = `${file}.tmp-${randomUUID()}`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* 权限补不上不阻塞退出钩子 */
    }
  }
}

function parseIndex(text: string, file: string): CoagentIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StoreError(
      `索引不是合法 JSON（${file}）：${describe(error)}；如需重建，删掉该文件（会丢掉历史记录）`,
    );
  }
  if (!isIndex(parsed)) {
    throw new StoreError(
      `索引形状不符（${file}）：需 version=1 与 records 对象；如需重建，删掉该文件`,
    );
  }
  return parsed;
}

async function chmodIfPossible(file: string, mode: number): Promise<void> {
  try {
    await chmod(file, mode);
  } catch {
    /* 忽略：权限收窄是尽力而为 */
  }
}
