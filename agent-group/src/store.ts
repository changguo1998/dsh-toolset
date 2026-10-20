/**
 * 组状态的两份存储实现：文件（`<管理者会话目录>/agent-group.json`）与内存（测试用）。
 *
 * 落盘口径（设计「状态落点」一节，2026-10-17 用户裁定）：管理者负责记录，落**管理者自己**
 * 的会话目录；原子写、权限 0600。目录由 `sessionPaths.sessionDirFor(managerSessionId)` 推导
 * （宿主建会话时已建好该目录，本包不建目录、只在缺失时报错）。
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { emptyBook } from "./model.ts";
import type { AgentGroupBook, BookStore } from "./types.ts";

/** 状态不可用（目录推导失败 / 读失败 / JSON 损坏 / 形状不符）—— 动作层转成 `state_unavailable`。 */
export class StateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateUnavailableError";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 最小形状校验（落盘形状被手改 / 截断时不静默接受）。 */
function isBook(value: unknown): value is AgentGroupBook {
  if (typeof value !== "object" || value === null) return false;
  const book = value as Partial<AgentGroupBook>;
  if (book.version !== 1) return false;
  if (typeof book.managerSessionId !== "string") return false;
  if (typeof book.groups !== "object" || book.groups === null) return false;
  for (const group of Object.values(book.groups)) {
    if (typeof group !== "object" || group === null) return false;
    const g = group as unknown as Record<string, unknown>;
    if (typeof g["id"] !== "string" || typeof g["name"] !== "string") {
      return false;
    }
    if (typeof g["createdAt"] !== "number") return false;
    if (typeof g["members"] !== "object" || g["members"] === null) return false;
    if (typeof g["links"] !== "object" || g["links"] === null) return false;
    if (!Array.isArray(g["instructions"])) return false;
  }
  return true;
}

/** 文件存储：`dirOf(managerSessionId)` 给会话目录，文件名固定（可配）。 */
export class FileBookStore implements BookStore {
  readonly #dirOf: (managerSessionId: string) => string;
  readonly #fileName: string;

  constructor(
    dirOf: (managerSessionId: string) => string,
    fileName = "agent-group.json",
  ) {
    this.#dirOf = dirOf;
    this.#fileName = fileName;
  }

  /** 状态文件绝对路径（排障与用例断言用）。 */
  pathOf(managerSessionId: string): string {
    return join(this.#dirOf(managerSessionId), this.#fileName);
  }

  #dir(managerSessionId: string): string {
    try {
      return this.#dirOf(managerSessionId);
    } catch (error) {
      throw new StateUnavailableError(
        `无法推导管理者会话目录（sessionPaths.sessionDirFor(${managerSessionId})）：${describe(error)}`,
      );
    }
  }

  async load(managerSessionId: string): Promise<AgentGroupBook> {
    const file = join(this.#dir(managerSessionId), this.#fileName);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyBook(managerSessionId);
      }
      throw new StateUnavailableError(
        `读取组状态失败（${file}）：${describe(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new StateUnavailableError(
        `组状态不是合法 JSON（${file}）：${describe(error)}；如需重建，删掉该文件后重新 create_group`,
      );
    }
    if (!isBook(parsed)) {
      throw new StateUnavailableError(
        `组状态形状不符（${file}）：需 version=1 / managerSessionId / groups；如需重建，删掉该文件后重新 create_group`,
      );
    }
    // 以当前会话为准（文件被复制到别的会话目录时不自作主张）。
    const book = { ...parsed, managerSessionId };
    // 向后兼容：旧版落盘没有 `peerLinks` 字段，补成空（决策项 4 的平等连接二期新增）。
    for (const group of Object.values(book.groups)) {
      (group as { peerLinks?: unknown }).peerLinks ??= {};
    }
    return book;
  }

  async save(book: AgentGroupBook): Promise<void> {
    const dir = this.#dir(book.managerSessionId);
    const file = join(dir, this.#fileName);
    const tmp = join(dir, `.${this.#fileName}.${randomUUID()}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, `${JSON.stringify(book, null, 2)}\n`, {
        mode: 0o600,
      });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw new StateUnavailableError(
        `写入组状态失败（${file}）：${describe(error)}`,
      );
    }
  }
}

/** 内存存储（单测 / 假宿主用；`save` 存深拷贝，断言时不受后续改动影响）。 */
export class MemoryBookStore implements BookStore {
  /** managerSessionId → 最近一次保存的状态。 */
  readonly books = new Map<string, AgentGroupBook>();
  /** 注入错误：下一次 load / save 抛它（测降级路径）。 */
  failLoad: Error | undefined;
  failSave: Error | undefined;
  /** 读写调用计数（断言「写状态的动作才落盘」）。 */
  loads = 0;
  saves = 0;

  async load(managerSessionId: string): Promise<AgentGroupBook> {
    this.loads += 1;
    if (this.failLoad !== undefined) throw this.failLoad;
    const book = this.books.get(managerSessionId);
    return book === undefined
      ? emptyBook(managerSessionId)
      : (structuredClone(book) as AgentGroupBook);
  }

  async save(book: AgentGroupBook): Promise<void> {
    this.saves += 1;
    if (this.failSave !== undefined) throw this.failSave;
    this.books.set(book.managerSessionId, structuredClone(book));
  }
}
