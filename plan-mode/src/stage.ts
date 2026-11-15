/**
 * plan-mode/src/stage.ts — 按帧快照推段（纯函数，无宿主依赖）。
 *
 * 输入是 task-engine `query().tasks` 的结构子集（id / status / children）与
 * plan 记录里的三段帧 id；输出「当前段」与「计划段是否已到终态」，前者供
 * 判定核与注入用，后者供恢复预设的轮询判断用（决策项 8a）。
 */

/** 会话当前所处的段。 */
export type Stage = "explore" | "plan" | "implement" | "unknown";

/** task-engine 任务项的结构子集（本包不依赖 task-engine 包）。 */
export interface TaskLike {
  id: string;
  title: string;
  status: string;
  children?: readonly TaskLike[];
}

/** 在嵌套任务清单里找某帧的状态（先序, 找到即返回）。 */
function statusOf(tasks: readonly TaskLike[], id: string): string | undefined {
  for (const item of tasks) {
    if (item.id === id) return item.status;
    if (item.children === undefined) continue;
    const child = statusOf(item.children, id);
    if (child !== undefined) return child;
  }
  return undefined;
}

/**
 * 按三段帧 id 推当前段：探索未 done → 探索; 探索 done 而计划未 done → 计划;
 * 两段都 done → 实施; 帧找不到（树缺失 / 对不上）→ 未知段。
 */
export function currentStage(
  tasks: readonly TaskLike[],
  frames: readonly [string, string, string],
): Stage {
  const s1 = statusOf(tasks, frames[0]);
  const s2 = statusOf(tasks, frames[1]);
  if (s1 === undefined || s2 === undefined) return "unknown";
  if (s1 === "done" && s2 === "done") return "implement";
  if (s1 === "done") return "plan";
  return "explore";
}

/** 计划段是否 done（放行判据, 判定顺序第 3 条）。 */
export function planDone(
  tasks: readonly TaskLike[],
  planFrameId: string,
): boolean {
  return statusOf(tasks, planFrameId) === "done";
}

/** 计划段是否已到终态（done 或 failed）: 恢复预设的触发条件（决策项 8a）。 */
export function planTerminal(
  tasks: readonly TaskLike[],
  planFrameId: string,
): boolean {
  const status = statusOf(tasks, planFrameId);
  return status === "done" || status === "failed";
}
