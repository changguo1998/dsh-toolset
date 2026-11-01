/**
 * 组层: 组生命周期（create_group / close_group）与只读查看（status / 服务面读组清单）。
 *
 * 只读路径不落盘、不镜像; 关闭组只终止组内派发与连接关系, 不连带关成员 agent。
 */

import { stringArg, type GroupActionHost } from "./action-host.ts";
import { DEFAULT_STUCK_AFTER_MS } from "./config.ts";
import { describe } from "./errors.ts";
import { memberStatesOf, type MemberStateLookup } from "./member.ts";
import {
  closeGroup as modelCloseGroup,
  createGroup as modelCreateGroup,
  failure,
  groupView,
  invariantViolations,
  isFailure,
  pickGroup,
} from "./model.ts";
import type {
  ActionResult,
  AgentGroupBook,
  BookStore,
  GroupFailure,
  GroupView,
  MemberStateView,
} from "./types.ts";

/**
 * 只读组清单（TUI `/group` 服务面）：按管理者会话 id 读落盘书，返回每组的只读视图。
 * 只读、不落盘、不镜像；文件缺失（ENOENT）由 `store.load` 按空组集处理。
 * `opts.memberLookup` 提供时附每组 `memberStates`（状态牌现算，BACKLOG #1）；缺省不判定。
 */
export async function readGroupStatus(
  store: BookStore,
  managerSessionId: string,
  groupName?: string,
  opts: {
    now?: () => number;
    stuckAfterMs?: number;
    memberLookup?: MemberStateLookup;
  } = {},
): Promise<
  | {
      ok: true;
      groups: Array<{
        name: string;
        view: GroupView;
        memberStates?: MemberStateView[];
      }>;
    }
  | GroupFailure
> {
  let book: AgentGroupBook;
  try {
    book = await store.load(managerSessionId);
  } catch (error) {
    return failure(
      "state_unavailable",
      `读取组状态失败：${describe(error)}`,
      "确认该会话目录存在且 agent-group.json 可读",
    );
  }
  const now = (opts.now ?? Date.now)();
  const stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const requested = (groupName ?? "").trim();
  if (requested !== "") {
    const group = book.groups[requested];
    if (group === undefined) {
      return failure(
        "group_not_found",
        `组「${requested}」不存在`,
        `现有组：${Object.keys(book.groups).join(", ") || "（无）"}`,
      );
    }
    const view = groupView(group);
    const memberStates = await memberStatesOf(
      group,
      opts.memberLookup,
      now,
      stuckAfterMs,
    );
    return {
      ok: true,
      groups: [
        {
          name: group.name,
          view,
          ...(memberStates === undefined ? {} : { memberStates }),
        },
      ],
    };
  }
  const out: Array<{
    name: string;
    view: GroupView;
    memberStates?: MemberStateView[];
  }> = [];
  for (const name of Object.keys(book.groups).sort((a, b) =>
    a.localeCompare(b),
  )) {
    const group = book.groups[name]!;
    const memberStates = await memberStatesOf(
      group,
      opts.memberLookup,
      now,
      stuckAfterMs,
    );
    out.push({
      name: group.name,
      view: groupView(group),
      ...(memberStates === undefined ? {} : { memberStates }),
    });
  }
  return { ok: true, groups: out };
}

/** 建组（管理者 = 调用方会话；只带组级参数，决策项 11）。 */
export async function createGroup(
  host: GroupActionHost,
  args: Record<string, unknown>,
  caller: string,
): Promise<ActionResult> {
  return host.locked(caller, async () => {
    const book = await host.load(caller);
    if (book === undefined) return host.stateFailure();
    const applied = modelCreateGroup(book, {
      ...(typeof args.name === "string" ? { name: args.name } : {}),
      managerSessionId: caller,
      now: host.now(),
      id: host.newId(),
    });
    if (isFailure(applied)) return applied;
    const saved = await host.persist(applied.book);
    if (saved !== undefined) return saved;
    await host.mirrorGroup(applied.group);
    return {
      ok: true,
      action: "create_group",
      group: applied.group.name,
      view: groupView(applied.group),
      next: `加成员：add_member group=${applied.group.name} name=<组内名> target=<会话 id 或别名>`,
    };
  });
}

/** 关闭组（#4 裁定 3）：仅组长（创建组的 agent）可关；关闭 = 组内派发任务结束、
 *  未结指令终止（timeout + cause）、连接关系关闭（此后写动作拒绝）、不连带关成员。 */
export async function closeGroup(
  host: GroupActionHost,
  args: Record<string, unknown>,
  caller: string,
): Promise<ActionResult> {
  return host.locked(caller, async () => {
    const book = await host.load(caller);
    if (book === undefined) return host.stateFailure();
    const groupName = stringArg(args, "group");
    const group = pickGroup(book, groupName);
    if (isFailure(group)) return group;
    if (caller !== group.managerSessionId) {
      return failure(
        "not_manager",
        `仅组长可关闭组（组「${group.name}」由 ${group.managerSessionId} 创建）`,
        "组长 = 建组的会话；成员如需退出请让组长 remove",
      );
    }
    const applied = modelCloseGroup(book, {
      group: groupName,
      now: host.now(),
    });
    if (isFailure(applied)) return applied;
    const saved = await host.persist(applied.book);
    if (saved !== undefined) return saved;
    await host.mirrorGroup(applied.group);
    return {
      ok: true,
      action: "close_group",
      group: groupName,
      closedAt: applied.group.closedAt,
      terminated: applied.terminated,
      view: groupView(applied.group),
      next:
        applied.terminated === 0
          ? "组已关闭：连接关系失效、不再接受写动作；成员 agent 不受影响。如需新组请 create_group 重建"
          : `组已关闭：${applied.terminated} 条未结指令已终止（timeout）；连接关系失效。成员 agent 不受影响。`,
    };
  });
}

/** 只读查看（成员、等级与主从关系、未结指令、最近一次回报，决策项 17）。 */
export async function status(
  host: GroupActionHost,
  args: Record<string, unknown>,
  caller: string,
): Promise<ActionResult> {
  // 只读：不落盘、不镜像；缓存命中时**不碰存储**（运行期 sessionDirFor 抛错也照常可读）。
  const book = await host.load(caller);
  if (book === undefined) return host.stateFailure();
  const group = pickGroup(book, stringArg(args, "group"));
  if (isFailure(group)) return group;
  const violations = invariantViolations(group);
  // 成员状态视图（BACKLOG #1 决策②③）：**状态巡查缓存优先**（2b 组长侧轮询），
  // 无缓存则现算并入缓存；状态读失败 → 该字段缺省，不阻塞只读
  const memberStates = await host.statesOf(caller, group);
  const view = groupView(group);
  return {
    ok: true,
    action: "status",
    group: group.name,
    view,
    ...(memberStates === undefined ? {} : { memberStates }),
    mirror: host.mirrorReport(),
    ...(violations.length === 0 ? {} : { violations }),
    next:
      violations.length === 0
        ? "只读视图：成员 / 等级与主从关系 / 未结指令 / 最近回报 / 成员状态"
        : "组状态存在不变量违规（见 violations）；建议重建组",
  };
}
