/**
 * plan-mode/src/session-map.ts — 会话 id → plan 记录（进程内内存）。
 *
 * 树不按会话隔离（§2.3 第 1 条）, 会话归属只能自持这张表：一个会话一份
 * 记录, 含三段帧 id、原预设（切成功才记值）、restored 标记与 Session 对象
 * （预设读写与恢复要按 Session 操作）。树完成 / 切走 / 会话结束 / 卸载时 drop。
 */

export interface PlanRecord {
  /** 三段帧 id, 顺序同 PLAN_NODES。 */
  frames: readonly [string, string, string];
  /** 进入前记录的权限预设（切成功才记值, 降级时缺失）。 */
  originalPreset?: string;
  /** 是否已恢复过（挡重复恢复, 二次进入时复位）。 */
  restored: boolean;
  /** Session 对象（预设的 current / set 按 Session 读写）。 */
  session?: unknown;
}

const records = new Map<string, PlanRecord>();

/** 登记 / 更新某会话的 plan 记录。 */
export function set(sessionId: string, record: PlanRecord): void {
  records.set(sessionId, record);
}

/** 取某会话的 plan 记录（没有返回 undefined）。 */
export function get(sessionId: string): PlanRecord | undefined {
  return records.get(sessionId);
}

/** 删除某会话的 plan 记录。 */
export function drop(sessionId: string): void {
  records.delete(sessionId);
}

/** 列出所有已登记的会话 id（插件卸载兜底遍历用）。 */
export function list(): string[] {
  return [...records.keys()];
}

/** 清空（仅测试用）。 */
export function clear(): void {
  records.clear();
}
