/**
 * 分类注册表（设计 §4 注册制）+ 层身份（设计 §2.1 数据路由）。
 *
 * 口径（2026-10-17 接口重设）：
 * - **注册是拿到写入句柄的唯一途径**（`registerKind` 返回 `MemoryScope`，见 `scope.ts`）；
 * - 运行期分类闸、兜底分类、事件认领、查询路由规则一并取消（事件沉淀已移出本包，
 *   读已全局可用，故不再需要「未注册拒写」与「按路由取舍检索」）；
 * - 声明面收窄为 `{ kind, table?, writableTiers?, preWrite? }`：`writableTiers` 是写侧隔离在
 *   层维度的落地（缺省只可写会话层），`preWrite` 是注册方的内容级硬闸（可建议 `importance`）。
 *
 * 路径推导不在本文件（S 层落点经宿主的 `sessionPaths.sessionDirFor(sessionId)` 解析，见 `tiers.ts`）。
 */

/** 记忆作用域层。 */
export type Tier = "session" | "project" | "user";

/** 全部层（顺序即 `usage()` / 检索并集的缺省顺序：S → P → U）。 */
export const TIERS: readonly Tier[] = ["session", "project", "user"];

/** 是合法的层名（运行期校验，供配置 / 句柄入参把关）。 */
export function isTier(value: unknown): value is Tier {
  return value === "session" || value === "project" || value === "user";
}

/** 写前钩子的判定结果（设计 §5：闸门在库核心，钩子在隐私闸之后、INSERT 之前）。 */
export interface KindVerdict {
  accept: boolean;
  reason?: string;
  /** 建议 `importance`（1..5）；不传则用调用方给的值。 */
  importance?: number;
}

/**
 * `preWrite` 的入参。**不含 `tier`**（2026-10-17 口径：需要「按层拦截」的消费方拆 kind，
 * 用 `writableTiers` 让句柄本身当闸门）。
 */
export interface KindWriteInput {
  content: string;
  title?: string;
  project: string;
  kind: string;
}

/** 注册声明（设计 §4 / 决策项 5）：只留四项。 */
export interface KindSpec {
  kind: string;
  /** 物理表名；缺省按 `kind` 派生（见 `kindTableName`）。 */
  table?: string;
  /** 可写层（缺省 `["session"]`）：不在其中的层写入一律抛错。 */
  writableTiers?: readonly Tier[];
  /** 内容级写前钩子：`accept: false` → 本次写入拒（`PutResult.skipped`），不抛错。 */
  preWrite?:
    | ((input: KindWriteInput) => KindVerdict)
    | ((input: KindWriteInput) => Promise<KindVerdict>);
}

/** 注册后的形态（表名与 FTS 表名已解析，`writableTiers` 已归一）。 */
export interface RegisteredKind {
  kind: string;
  table: string;
  fts: string;
  trigram: string;
  writableTiers: readonly Tier[];
  preWrite?: (input: KindWriteInput) => KindVerdict | Promise<KindVerdict>;
}

/** 表名白名单：SQLite 不支持标识符参数绑定，只能校验后拼串。 */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
/** 保留与影子表名：撞上会破坏 `sources` 或 FTS5 的内部表。 */
const RESERVED_TABLE = /^sources$|_fts$|_trigram_fts$/;

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

/**
 * 分类注册表（设计 §4 的「注册制」）。进程内一份，注册后由各层库按需建表。
 * 同名 / 同表重复注册即报错（避免静默改写别人的声明）。
 */
export class KindRegistry {
  readonly #byKind = new Map<string, RegisteredKind>();
  readonly #tableOwner = new Map<string, string>();

  /** 注册一个分类；返回已解析的注册项（句柄由 `scope.ts` 按它构造）。 */
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
    const entry: RegisteredKind = {
      kind,
      table,
      fts: `${table}_fts`,
      trigram: `${table}_trigram_fts`,
      writableTiers: normalizeTiers(kind, spec.writableTiers),
      ...(spec.preWrite === undefined ? {} : { preWrite: spec.preWrite }),
    };
    this.#byKind.set(kind, entry);
    this.#tableOwner.set(table, kind);
    return entry;
  }

  /** 按名字取注册项；未注册返回 `undefined`。 */
  resolve(kind?: string): RegisteredKind | undefined {
    return kind === undefined ? undefined : this.#byKind.get(kind);
  }

  /** 已注册的全部分类（缺省即跨 kind 读取的并集面）。 */
  list(): readonly RegisteredKind[] {
    return [...this.#byKind.values()];
  }
}

/** `writableTiers` 归一：缺省 `["session"]`，重复项去掉，非层名 / 空数组抛错。 */
function normalizeTiers(
  kind: string,
  input: readonly Tier[] | undefined,
): readonly Tier[] {
  if (input === undefined) return ["session"];
  const out: Tier[] = [];
  for (const tier of input) {
    if (!isTier(tier)) {
      throw new Error(
        `分类「${kind}」的 writableTiers 含非法层「${String(tier)}」`,
      );
    }
    if (!out.includes(tier)) out.push(tier);
  }
  if (out.length === 0) {
    throw new Error(`分类「${kind}」的 writableTiers 不能为空数组`);
  }
  return out;
}
