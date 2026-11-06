/**
 * agent-group/src/summary.ts — 项目层成员关系索引与按会话的摘要（纯函数 + 类型）。
 *
 * 组账本按**管理者会话目录**存（`store.ts`），单看某个会话的账本读不到「我加入了哪些组」。
 * 这里定义写进 memory-base **项目层**的索引行（可全局列举）与其上的摘要计算：
 * - 索引行每次组状态变更后写一次（`mirror.ts` 负责落库）；
 * - `summarize(rows, sessionId)` 取每个组最新一行，分出「我创建的组」与「我加入的组」。
 */

import { MANAGER_NAME } from "./model.ts";
import type { AgentGroupState } from "./types.ts";

/** 索引分类名（memory-base 的 kind；与镜像 `agent_group` 分开, 因 kind 进程内唯一）。 */
export const INDEX_KIND = "agent_group_index";

/** 索引成员（保留 sessionId 才能按会话过滤）。 */
export interface IndexMember {
  name: string;
  sessionId: string;
  role: "manager" | "member";
  level: number;
}

/** 索引行（写进项目层的 JSON 正文）。 */
export interface GroupIndexRow {
  name: string;
  managerSessionId: string;
  members: IndexMember[];
  links: Array<{ from: string; to: string }>;
}

/** 按会话的摘要。 */
export interface GroupSummaryView {
  created: Array<{ name: string; children: string[] }>;
  joined: Array<{ name: string; parent: string }>;
}

/** 组状态 → 索引行。 */
export function indexPayload(group: AgentGroupState): GroupIndexRow {
  return {
    name: group.name,
    managerSessionId: group.managerSessionId,
    members: Object.values(group.members).map((member) => ({
      name: member.name,
      sessionId: member.sessionId,
      role: member.role,
      level: member.level,
    })),
    links: Object.values(group.links).map((link) => ({
      from: link.from,
      to: link.to,
    })),
  };
}

/**
 * 摘要：`rows` 按写入时间正序（旧 → 新），同名组后写覆盖先写。
 *
 * - 我创建的组 = `managerSessionId` 是我的组 → 直接子 = `links` 里 `from === "manager"` 的 `to`；
 * - 我加入的组 = 我以非管理者身份出现在 `members` → 上级 = `links` 里 `to === 我` 的 `from`。
 */
export function summarize(
  rows: readonly GroupIndexRow[],
  sessionId: string,
): GroupSummaryView {
  const latest = new Map<string, GroupIndexRow>();
  for (const row of rows) latest.set(row.name, row);
  const created: Array<{ name: string; children: string[] }> = [];
  const joined: Array<{ name: string; parent: string }> = [];
  for (const row of latest.values()) {
    if (row.managerSessionId === sessionId) {
      created.push({
        name: row.name,
        children: row.links
          .filter((link) => link.from === MANAGER_NAME)
          .map((link) => link.to),
      });
      continue;
    }
    const me = row.members.find(
      (member) => member.sessionId === sessionId && member.role !== "manager",
    );
    if (me === undefined) continue;
    const link = row.links.find((item) => item.to === me.name);
    joined.push({ name: row.name, parent: link?.from ?? MANAGER_NAME });
  }
  return { created, joined };
}
