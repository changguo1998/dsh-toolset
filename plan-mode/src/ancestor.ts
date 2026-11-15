/**
 * plan-mode/src/ancestor.ts — 父会话链上溯（子代理写调用继承父会话阶段）。
 *
 * 宿主在创建子代理时于子会话 header 持久化直接父会话 id `parentSession`
 * （dsh-subagent 的 `childSessionMeta`）；`tools/pre-execute` 的 exec 携带调用方
 * agent，其 `.session.header.parentSession` 即「我」的直接父，后续经 `agents`
 * 服务的 `get(id).session.header.parentSession` 逐级可读祖父。
 *
 * 本文件只做纯函数：给定 plan 记录查询与父链读取器，沿链找最近的 plan 记录
 * （含自身）。跳数上限防病态长链 / 环。
 */

/** 上溯跳数上限（宿主不设默认深度上限，这里兜底防长链 / 环）。 */
export const ANCESTOR_MAX_HOPS = 24;

/** `agents` 服务在本组件的消费形态（真机 `ctx.get("agents").get(id)` 返回 agent）。 */
export interface AgentsLike {
  get(
    id: string,
  ):
    | { session?: { header?: { parentSession?: string | undefined } } }
    | undefined;
}

/** 会话 → 直接父会话 id（undefined = 顶）。 */
export type ParentOf = (sessionId: string) => string | undefined;

/** 会话 → plan 记录。 */
export type RecordOf<T> = (sessionId: string) => T | undefined;

/**
 * 沿 parentSession 链（含自身）找最近的 plan 记录。
 * @returns 命中时给记录与所在会话 id；链尽 / 超限返回 undefined。
 */
export function nearestPlanRecord<T>(
  startSessionId: string,
  recordOf: RecordOf<T>,
  parentOf: ParentOf,
): { sessionId: string; record: T } | undefined {
  let cursor: string | undefined = startSessionId;
  for (
    let hops = 0;
    cursor !== undefined && hops <= ANCESTOR_MAX_HOPS;
    hops++
  ) {
    const record = recordOf(cursor);
    if (record !== undefined) return { sessionId: cursor, record };
    cursor = parentOf(cursor);
  }
  return undefined;
}

/** 从 `agents` 服务构建父链读取器（装配端用；服务缺席时恒 undefined）。 */
export function makeParentReader(agents: AgentsLike | undefined): ParentOf {
  return (sessionId) => agents?.get(sessionId)?.session?.header?.parentSession;
}
