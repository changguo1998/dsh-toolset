/**
 * 状态列 Task 块取数（纯函数）：把宿主 `taskEngine.query()` 快照折成
 * `StatusExtras.task`（活跃数 / 总数 / 当前任务栈标题）。
 *
 * 为什么要在这里判定「有没有任务」：宿主 `task-engine` 构造时就落一条
 * `plan/root-created`（`task-engine/src/engine.ts:104-110`, 根帧缺省标题「当前任务」）,
 * 启动后把所有 `pending` 帧入就绪池（`engine.ts:128-131`）—— 于是**没有用户任务时**
 * `frameStack` 也是 `[<根帧>]`（非空）。直接按栈非空建块会显示空的 `Task 0/1`。
 *
 * 为什么要自建路径：宿主的 `frameStack` 是**就绪池**（`task-engine/src/engine-store.ts:135-138`,
 * DFS 栈, 末位 = 下一待处理帧）, 不是「当前帧 → 根」的一条链; 且帧被 `nextReady()` 取走后
 * 就离开池子（`engine-store.ts:72-82`）, 所以在途帧在池里看不到。这里改由快照自带的
 * `parentId`（`task-engine/src/types.ts:225-237`）沿父链上溯, 得到「根 … 当前帧」的链路。
 *
 * 判定口径（2026-11-08 定案）:
 * - 「无任务」= 除根帧外没有任何其他帧, 且没有 `active` 帧 → 不建块;
 * - 「当前帧」= 唯一的 active 帧（没有则取池顶 = 下一待处理帧）;
 * - 展示顺序 = 根在下、当前帧在上（`stack` 末位标 ●）。
 */

/** 宿主快照里本模块用到的字段子集（结构面声明，不 import 宿主包）。 */
export interface TaskQueryLike {
  query?(): {
    tasks?: readonly TaskNodeLike[];
    frameStack?: readonly string[];
    activeCount?: number;
  };
}

/** 宿主 `NestedTaskItem` 的宽松子集。 */
export interface TaskNodeLike {
  id?: string;
  parentId?: string | null;
  title?: string;
  status?: string;
  children?: readonly TaskNodeLike[];
}

/** 状态列 Task 块的展示快照（与 `StatusExtras["task"]` 同形）。 */
export interface TaskExtrasLike {
  active: number;
  total: number;
  stack: string[];
}

/** 一次 `query()` 快照里本模块用到的字段。 */
export interface TaskSnapshotLike {
  tasks?: readonly TaskNodeLike[];
  frameStack?: readonly string[];
  activeCount?: number;
}

/** 先序展平嵌套任务树。 */
function flatten(
  items: readonly TaskNodeLike[],
  out: TaskNodeLike[] = [],
): TaskNodeLike[] {
  for (const item of items) {
    out.push(item);
    if (Array.isArray(item.children)) flatten(item.children, out);
  }
  return out;
}

/**
 * 取当前帧：优先先序里第一个 `active` 帧；没有在途帧时取就绪池顶（末位 = 下一待处理帧）。
 * 返回 `undefined` = 没有任何可指的帧。
 */
function currentFrameOf(
  nodes: readonly TaskNodeLike[],
  pool: readonly string[],
): string | undefined {
  for (const node of nodes) {
    if (node.status === "active" && typeof node.id === "string") return node.id;
  }
  return pool.at(-1);
}

/**
 * 沿 `parentId` 上溯得到「根 → 当前帧」的 id 链。
 * 父链断开（快照里查不到父帧）时就地停住, 不把查不到的父 id 混进展示;
 * 成环时靠 `seen` 截断。
 */
function pathToRoot(
  current: string,
  byId: ReadonlyMap<string, TaskNodeLike>,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = current;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    const parentId: string | null | undefined =
      byId.get(cursor)?.parentId ?? null;
    cursor =
      typeof parentId === "string" && byId.has(parentId) ? parentId : undefined;
  }
  return chain.reverse();
}

/**
 * 从查询快照折出 Task 块快照；返回 `undefined` = 不建块（没有真实任务 / 快照不可用）。
 */
export function taskExtrasOf(
  snapshot: TaskSnapshotLike | undefined,
): TaskExtrasLike | undefined {
  if (snapshot === undefined) return undefined;
  const nodes = flatten(snapshot.tasks ?? []);
  const active = snapshot.activeCount ?? 0;
  // 没有真实任务：树里只剩根帧（或根本没有帧）, 且没有在途帧。
  const hasRealWork = nodes.length > 1 || active > 0;
  if (!hasRealWork) return undefined;

  const byId = new Map<string, TaskNodeLike>();
  const titles = new Map<string, string>();
  for (const node of nodes) {
    if (typeof node.id !== "string") continue;
    byId.set(node.id, node);
    if (typeof node.title === "string") titles.set(node.id, node.title);
  }

  const current = currentFrameOf(nodes, snapshot.frameStack ?? []);
  // 当前帧不可指（池空且无在途帧, 例如全部完成）→ 不建块。
  if (current === undefined) return undefined;

  return {
    active,
    total: titles.size,
    stack: pathToRoot(current, byId).map((id) => titles.get(id) ?? id),
  };
}
