/**
 * 状态列 Task 块取数（纯函数）：把宿主 `taskEngine.query()` 快照折成
 * `StatusExtras.task`（活跃数 / 总数 / 当前任务栈标题）。
 *
 * 为什么要在这里判定「有没有任务」：宿主 `task-engine` 构造时就落一条
 * `plan/root-created`（`task-engine/src/engine.ts:104-110`, 根帧缺省标题「当前任务」）,
 * 启动后把所有 `pending` 帧入就绪池（`engine.ts:128-131`）—— 于是**没有用户任务时**
 * `frameStack` 也是 `[<根帧>]`（非空）。直接按栈非空建块会显示空的 `Task 0/1`。
 *
 * 判定口径（2026-11-08 定案）: 除根帧外没有任何其他帧, 且没有 `active` 帧 = 没有真实任务。
 * 根被拆过（有子帧）或根被激活（`activeCount > 0`）都算有任务; 有子帧但全部 done 时
 * 仍显示（用户要看到 `Task 0/N`）。
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
 * 从查询快照折出 Task 块快照；返回 `undefined` = 不建块（没有真实任务 / 快照不可用）。
 */
export function taskExtrasOf(
  snapshot:
    | {
        tasks?: readonly TaskNodeLike[];
        frameStack?: readonly string[];
        activeCount?: number;
      }
    | undefined,
): TaskExtrasLike | undefined {
  if (snapshot === undefined) return undefined;
  const stack = snapshot.frameStack ?? [];
  if (stack.length === 0) return undefined;

  const nodes = flatten(snapshot.tasks ?? []);
  const active = snapshot.activeCount ?? 0;
  // 没有真实任务：树里只剩根帧（或根本没有帧）, 且没有在途帧。
  const hasRealWork = nodes.length > 1 || active > 0;
  if (!hasRealWork) return undefined;

  const titles = new Map<string, string>();
  for (const node of nodes) {
    if (typeof node.id === "string" && typeof node.title === "string") {
      titles.set(node.id, node.title);
    }
  }
  return {
    active,
    total: titles.size,
    stack: stack.map((id) => titles.get(id) ?? id),
  };
}
