/**
 * 三层库的路径推导与层身份（设计 §2.1 数据路由、§12 #10 存储位置迁移）。
 *
 * | 层 | 库 | 位置 |
 * | --- | --- | --- |
 * | S 会话 | `session.db` | 宿主会话目录（**不自建** `<dshHome>/memory-base/sessions/`） |
 * | P 项目 | `project.db` | 项目根 `.dsh/` |
 * | U 用户 | `user.db` | `~/.dsh/memory-base/` |
 *
 * 只有根目录可经配置覆盖。会话目录**解析不到就返回 undefined**（调用方告警），不静默换路径
 * ——宿主 0.2.0-rc.2 未暴露「会话目录」读取面，实施时按 `<sessionsRoot>/<projectKey(cwd)>/<id>/`
 * 约定拼接（见 DESIGN §2.1 的核实结论）。
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 记忆作用域层。 */
export type Tier = "session" | "project" | "user";

export interface TierPathInput {
  /** 宿主会话目录（绝对路径）；解析不到就不要传。 */
  sessionDir?: string;
  /** 项目根（通常是会话 `header.cwd`）；不传则无 P 库。 */
  projectRoot?: string;
  /** 存储根：宿主 `dshHomePath(...)` 的父目录；缺省 `~/.dsh`。 */
  dshHome?: string;
}

export interface TierPaths {
  /** 会话库路径；无会话目录时为 `undefined`。 */
  session?: string;
  /** 项目库路径；无项目根时为 `undefined`。 */
  project?: string;
  /** 用户库路径（总是可推导）。 */
  user: string;
}

/** 库文件名（随层固定）。 */
export const TIER_DB_FILES: Record<Tier, string> = {
  session: "session.db",
  project: "project.db",
  user: "user.db",
};

/** 按层推导三个库的路径。 */
export function resolveTierPaths(input: TierPathInput = {}): TierPaths {
  const dshHome = resolve(input.dshHome ?? join(homedir(), ".dsh"));
  const paths: TierPaths = {
    user: join(dshHome, "memory-base", TIER_DB_FILES.user),
  };
  if (input.sessionDir !== undefined && input.sessionDir.length > 0) {
    paths.session = join(resolve(input.sessionDir), TIER_DB_FILES.session);
  }
  if (input.projectRoot !== undefined && input.projectRoot.length > 0) {
    paths.project = join(
      resolve(input.projectRoot),
      ".dsh",
      TIER_DB_FILES.project,
    );
  }
  return paths;
}

/**
 * 宿主会话目录的约定拼接（设计 §2.1）：`<sessionsRoot>/<projectKey(cwd)>/<sessionId>/`。
 * `projectKey` = cwd 去掉前导分隔符后把分隔符换成 `-`（与宿主分桶一致）。
 * **未经宿主承诺**，解析不到时调用方应告警而非静默使用。
 */
export function sessionDirFor(
  sessionsRoot: string,
  cwd: string,
  sessionId: string,
): string {
  const key = resolve(cwd)
    .replace(/^[/\\]+/, "")
    .replace(/[/\\]+/g, "-");
  return join(resolve(sessionsRoot), key, sessionId);
}

/** 分类表的扩展列（设计 §4：由注册方声明；只允许**可空**列）。 */
export interface KindColumn {
  name: string;
  type: "TEXT" | "INTEGER" | "REAL" | "BLOB";
}

/** 写前钩子的判定结果（设计 §5：闸门在库核心，钩子在闸门之后、INSERT 之前）。 */
export interface KindVerdict {
  accept: boolean;
  reason?: string;
  /** 建议 `importance`（1..5）；不传则用调用方给的值。 */
  importance?: number;
}

export interface KindWriteInput {
  content: string;
  title?: string;
  project: string;
  kind: string;
}

export interface KindRouteQuery {
  query: string;
  project?: string;
  target?: string;
  kind?: string;
}

/** 注册项（设计 §4）：`kind` + 表名 + 扩展列 + 事件认领 + 写前钩子 + 查询路由规则。 */
export interface KindSpec {
  kind: string;
  /** 物理表名；缺省按 `kind` 派生（见 `kindTableName`）。 */
  table?: string;
  columns?: readonly KindColumn[];
  /** 本分类认领的事件类型（写入方的 `category`）→ 自动路由到本分类。 */
  eventTypes?: readonly string[];
  preWrite?: (input: KindWriteInput) => KindVerdict;
  /** 查询路由规则：返回 false 表示该分类不参与本次检索（未声明 = 通配参与）。 */
  routes?: (opts: KindRouteQuery) => boolean;
}

/** 注册后的形态（表名与 FTS 表名已解析）。 */
export interface RegisteredKind {
  kind: string;
  table: string;
  fts: string;
  trigram: string;
  columns: readonly KindColumn[];
  eventTypes: readonly string[];
  preWrite?: (input: KindWriteInput) => KindVerdict;
  routes?: (opts: KindRouteQuery) => boolean;
}

/** 表名 / 列名白名单：SQLite 不支持标识符参数绑定，只能校验后拼串。 */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
/** 保留与影子表名：撞上会破坏 `sources` 或 FTS5 的内部表。 */
const RESERVED_TABLE =
  /^(sources|chunks_fts|chunks_trigram_fts)$|_fts$|_trigram_fts$/;

/**
 * 兜底分类的物理表名＝v1 布局的 `chunks`（决策 D38）：不改名、不迁移、不 bump 版本，
 * 既有的 v1 库因此照常打开。（2026-10-08：跨包直写方 `output-compress` 已拆除共库
 * 直写、改自持 digest.db——`chunks` 兜底表名仅为存量 v1 库兼容保留。）
 */
export const FALLBACK_TABLE = "chunks";

/** `kind` → 缺省表名（`kind_<归一化>`）。派生规则在代码里，**具体分类名不在代码里**。 */
export function kindTableName(kind: string): string {
  const slug = kind
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const name = `kind_${slug}`;
  if (!IDENTIFIER.test(name) || RESERVED_TABLE.test(name)) {
    throw new Error(`分类「${kind}」无法派生合法表名（得到「${name}」）`);
  }
  return name;
}

/** 兜底分类的注册项：表名固定为 `chunks`（D38）。 */
export function fallbackSpec(kind: string): KindSpec {
  return { kind, table: FALLBACK_TABLE };
}

/**
 * 分类注册表（设计 §4 的「注册制」）。进程内一份，注册后由各层库按需建表。
 * 未注册的 `kind` 一律拒写（`pick` 返回 `undefined`），U 层不允许落兜底。
 */
export class KindRegistry {
  readonly #fallbackKind: string;
  readonly #byKind = new Map<string, RegisteredKind>();
  readonly #tableOwner = new Map<string, string>();

  constructor(options: { fallbackKind?: string } = {}) {
    this.#fallbackKind = options.fallbackKind ?? "default";
  }

  get fallbackKind(): string {
    return this.#fallbackKind;
  }

  /** 注册一个分类；同名 / 同表重复注册即报错（避免静默改写别人声明的列）。 */
  register(spec: KindSpec): RegisteredKind {
    const kind = spec.kind.trim();
    if (kind.length === 0) throw new Error("分类名不能为空");
    if (this.#byKind.has(kind)) throw new Error(`分类「${kind}」已注册`);
    const table = spec.table?.trim() ?? kindTableName(kind);
    if (!IDENTIFIER.test(table) || RESERVED_TABLE.test(table)) {
      throw new Error(`分类「${kind}」的表名「${table}」不合法`);
    }
    const owner = this.#tableOwner.get(table);
    if (owner !== undefined) {
      throw new Error(`表「${table}」已属于分类「${owner}」`);
    }
    const columns = spec.columns ?? [];
    const seen = new Set<string>();
    for (const column of columns) {
      if (!IDENTIFIER.test(column.name) || seen.has(column.name)) {
        throw new Error(
          `分类「${kind}」的扩展列「${column.name}」不合法或重复`,
        );
      }
      seen.add(column.name);
    }
    const entry: RegisteredKind = {
      kind,
      table,
      fts: `${table}_fts`,
      trigram: `${table}_trigram_fts`,
      columns,
      eventTypes: spec.eventTypes ?? [],
      ...(spec.preWrite === undefined ? {} : { preWrite: spec.preWrite }),
      ...(spec.routes === undefined ? {} : { routes: spec.routes }),
    };
    this.#byKind.set(kind, entry);
    this.#tableOwner.set(table, kind);
    return entry;
  }

  /** 按名字取注册项；未注册返回 `undefined`。 */
  resolve(kind?: string): RegisteredKind | undefined {
    return kind === undefined ? undefined : this.#byKind.get(kind);
  }

  /** 兜底分类的注册项（尚未注册时为 `undefined`）。 */
  fallback(): RegisteredKind | undefined {
    return this.#byKind.get(this.#fallbackKind);
  }

  /**
   * 写入路由（设计 §4 / §5）：显式 `kind` > 事件类型认领 > 兜底分类。
   * 返回 `undefined` = 拒写（未注册的 `kind`，或兜底分类尚未注册）。
   */
  pick(input: {
    kind?: string;
    eventType?: string;
  }): RegisteredKind | undefined {
    if (input.kind !== undefined) return this.#byKind.get(input.kind);
    if (input.eventType !== undefined) {
      for (const entry of this.#byKind.values()) {
        if (entry.eventTypes.includes(input.eventType)) return entry;
      }
    }
    return this.fallback();
  }

  list(): readonly RegisteredKind[] {
    return [...this.#byKind.values()];
  }

  /** 参与本次检索的分类集合（设计 §7：给了 `kind` 只查该表；否则按各分类的路由规则）。 */
  participants(opts: KindRouteQuery): RegisteredKind[] {
    if (opts.kind !== undefined) {
      const one = this.#byKind.get(opts.kind);
      return one === undefined ? [] : [one];
    }
    return this.list().filter((entry) => entry.routes?.(opts) ?? true);
  }
}
