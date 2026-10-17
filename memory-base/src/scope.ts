/**
 * 写入作用域句柄（决策项 1 选 b / 决策项 3 选 a）：**按扩展隔离的唯一机械落点**。
 *
 * 机制：
 * - 句柄由 `registerKind(spec)` 返回，绑定该扩展的 kind 与 `writableTiers`；写入与删除只经句柄
 *   （全局面 `ctx.get("memory")` 上没有任何写入键）；
 * - **参数级与权限级一律抛错**（`Error`，文案带 kind 与 tier）：`tier` 不在 `writableTiers`、
 *   写会话层却没给 `sessionId`、目标层库不可用；
 * - **内容级闸门不抛错**：隐私闸命中或注册方 `preWrite` 拒绝 → `PutResult.skipped`（`ids` 为空）。
 */

import type {
  KnowledgeService,
  PutResult,
  RowRef,
  SourceRef,
} from "./knowledge.ts";
import { isTier, type RegisteredKind, type Tier } from "./router.ts";

/** 写入入参（对外形态；`project` / `sessionId` 的落点由本插件解析）。 */
export interface ScopePutInput {
  content: string;
  /** 目标层；缺省 `"session"`。不在 `writableTiers` 内 → 抛错。 */
  tier?: Tier;
  /** 归属项目键；缺省由宿主按调用方所在项目注入。 */
  project?: string;
  title?: string;
  /** clamp 1..5；可被 `preWrite` 建议覆盖。 */
  importance?: number;
  source?: SourceRef;
  /** 写会话层时必需（落点由本插件按它解析）；写 P / U 层时可选，给了就落 `session_id` 列。 */
  sessionId?: string;
}

/** 单个层的删除目标（真删，返回删除条数）。 */
export interface ForgetRef {
  tier: Tier;
  ids: readonly number[];
}

/** 写入作用域句柄（按扩展隔离的唯一机械落点）。 */
export interface MemoryScope {
  readonly kind: string;
  readonly writableTiers: readonly Tier[];
  put(input: ScopePutInput): Promise<PutResult>;
  forget(refs: readonly ForgetRef[]): Promise<number>;
}

/** 句柄依赖的宿主能力（由 `src/index.ts` 的 bundle 提供）。 */
export interface ScopeHost {
  /** 该层可写库；层库尚未创建时按需创建，不可用（路径解析失败 / 库打开失败）抛明示例外。 */
  openWritable(tier: Tier, sessionId?: string): Promise<KnowledgeService>;
  /** 该层已打开的库；未打开过返回 `undefined`（删除只作用于已存在的库）。 */
  opened(tier: Tier, sessionId?: string): KnowledgeService | undefined;
  /** 调用方所在项目键（句柄未显式给 `project` 时用它）。 */
  defaultProject(): string;
}

/**
 * 造一个句柄：解析 kind 的注册项（未注册直接抛错——拿不到句柄就写不了），
 * 并把每次写入 / 删除转发到对应层的 `KnowledgeService`。
 */
export function createMemoryScope(
  host: ScopeHost,
  entry: RegisteredKind,
): MemoryScope {
  /** 最近一次会话层写入的会话 id（会话层库按会话区分，删除时据此定位同一库）。 */
  let lastSessionId: string | undefined;
  const requireTier = (
    input: ScopePutInput,
    writable: readonly Tier[],
  ): Tier => {
    const tier = input.tier ?? "session";
    if (!isTier(tier)) {
      throw new Error(
        `memory-base 分类「${entry.kind}」的写入层「${String(tier)}」不是合法层`,
      );
    }
    if (!writable.includes(tier)) {
      throw new Error(
        `memory-base 分类「${entry.kind}」不可写 ${tier} 层（注册时声明的是 ${writable.join(" / ")}）`,
      );
    }
    return tier;
  };

  return {
    kind: entry.kind,
    writableTiers: entry.writableTiers,
    async put(input: ScopePutInput): Promise<PutResult> {
      const writable = entry.writableTiers;
      const tier = requireTier(input, writable);
      if (tier === "session" && (input.sessionId ?? "").length === 0) {
        throw new Error(
          `memory-base 分类「${entry.kind}」写会话层需要 sessionId（会话层落点按会话解析）`,
        );
      }
      // 会话层的库按会话区分：记下最近一次写入的会话，删除时用它定位同一库。
      if (tier === "session") lastSessionId = input.sessionId;
      const kb = await host.openWritable(tier, input.sessionId);
      return kb.put({
        kind: entry.kind,
        project: input.project ?? host.defaultProject(),
        content: input.content,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.importance === undefined
          ? {}
          : { importance: input.importance }),
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        ...(input.source === undefined ? {} : { source: input.source }),
      });
    },
    async forget(refs: readonly ForgetRef[]): Promise<number> {
      let removed = 0;
      for (const ref of refs) {
        if (!isTier(ref.tier)) {
          throw new Error(
            `memory-base 分类「${entry.kind}」的删除层「${String(ref.tier)}」不是合法层`,
          );
        }
        if (!entry.writableTiers.includes(ref.tier)) {
          throw new Error(
            `memory-base 分类「${entry.kind}」不可写 ${ref.tier} 层（注册时声明的是 ${entry.writableTiers.join(" / ")}）`,
          );
        }
        const kb = host.opened(
          ref.tier,
          ref.tier === "session" ? lastSessionId : undefined,
        );
        if (kb === undefined) continue;
        removed += kb.evict(
          ref.ids.map((id): RowRef => ({ kind: entry.kind, id })),
        );
      }
      return removed;
    },
  };
}
