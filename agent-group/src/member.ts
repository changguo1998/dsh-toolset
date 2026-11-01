/**
 * 成员层: 加成员 / 移除成员的动作编排, 以及成员忙闲判定（状态牌决策②③）。
 *
 * 判定只读传输面（在线集 + 状态牌）, 不涉及目标 agent 的工作循环、不产生推理。
 */

import { stringArg, type GroupActionHost } from "./action-host.ts";
import {
  addMember as modelAddMember,
  failure,
  groupView,
  isFailure,
  nameError,
  pickGroup,
  removeMember as modelRemoveMember,
} from "./model.ts";
import type {
  ActionResult,
  AgentGroupState,
  AgentStateVerdict,
  GroupFailure,
  MemberStateView,
} from "./types.ts";

/** 成员忙闲判定的状态牌来源（结构面；`GroupTransport` 满足）。 */
export interface MemberStateLookup {
  peers(): Promise<{ ok: true; sessionIds: string[] } | GroupFailure>;
  statusOf(
    sessionId: string,
  ): Promise<
    | { ok: true; state?: { status: "idle" | "running"; at: number } }
    | GroupFailure
  >;
}

/**
 * 成员忙闲判定（状态牌决策③，纯函数）：
 * 不在在线集 = `offline`；`idle` = `idle`（待机）；`running` 且 `at` 距今未超
 * `stuckAfterMs` = `working`（工作）；`running` 且 `at` 超阈值 = `stuck`（疑似卡死）。
 * 在线但无状态牌（未发布的旧对端）按 `idle` 处理 —— 不误报卡死。
 */
export function judgeAgentState(input: {
  online: boolean;
  state?: { status: "idle" | "running"; at: number };
  now: number;
  stuckAfterMs: number;
}): AgentStateVerdict {
  if (!input.online) return "offline";
  const state = input.state;
  if (state === undefined) return "idle";
  if (state.status === "idle") return "idle";
  return input.now - state.at > input.stuckAfterMs ? "stuck" : "working";
}

/**
 * 现算一个组全部成员的状态视图（决策②③）：在线集一次取 + 每成员状态牌单读，
 * 判定不涉及目标 agent 工作循环、不产生推理（目标卡死时依然可判）。
 * transport 缺失 / 读失败 → `undefined`（状态不可用，不阻塞 `status` 本身的只读返回）。
 */
export async function memberStatesOf(
  group: AgentGroupState,
  lookup: MemberStateLookup | undefined,
  now: number,
  stuckAfterMs: number,
): Promise<MemberStateView[] | undefined> {
  if (lookup === undefined) return undefined;
  try {
    const onlineResult = await lookup.peers();
    if (!onlineResult.ok) return undefined;
    const online = new Set(onlineResult.sessionIds);
    const out: MemberStateView[] = [];
    for (const member of Object.values(group.members)) {
      const isOnline = online.has(member.sessionId);
      let raw: { status: "idle" | "running"; at: number } | undefined;
      const stateResult = await lookup.statusOf(member.sessionId);
      if (!stateResult.ok) {
        // 单成员状态牌读失败：按「在线无牌」处理，不误报卡死，继续其余成员
        raw = undefined;
      } else {
        raw = stateResult.state;
      }
      out.push({
        name: member.name,
        sessionId: member.sessionId,
        state: judgeAgentState({
          online: isOnline,
          state: raw,
          now,
          stuckAfterMs,
        }),
        ...(raw === undefined ? {} : { rawStatus: raw.status, at: raw.at }),
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

/** 加成员（一次一个；目标须在线且唯一命中，决策项 3 / 11）。 */
export async function addMember(
  host: GroupActionHost,
  args: Record<string, unknown>,
  caller: string,
): Promise<ActionResult> {
  return host.locked(caller, async () => {
    const book = await host.load(caller);
    if (book === undefined) return host.stateFailure();
    const groupName = stringArg(args, "group");
    const closed = host.closedGuard(book, groupName);
    if (closed !== undefined) return closed;
    const name = stringArg(args, "name");
    const target = stringArg(args, "target");
    const found = pickGroup(book, groupName);
    if (isFailure(found)) return found;
    const bad = nameError("成员名", name);
    if (bad !== undefined) {
      return failure("invalid_argument", bad, "成员名用 1-32 位 [A-Za-z0-9_-]");
    }
    const resolved = await host.guard("寻址目标", () =>
      host.transport.resolve(target),
    );
    if (isFailure(resolved)) return { ...resolved, group: groupName };
    const applied = modelAddMember(book, {
      group: groupName,
      name,
      target,
      sessionId: resolved.sessionId,
      now: host.now(),
    });
    if (isFailure(applied)) return applied;
    const saved = await host.persist(applied.book);
    if (saved !== undefined) return saved;
    await host.mirrorGroup(applied.group);
    return {
      ok: true,
      action: "add_member",
      group: groupName,
      member: name,
      sessionId: resolved.sessionId,
      view: groupView(applied.group),
      next: `建立主从连接：link group=${groupName} from=<主方> to=${name}（从方须是自由代理）`,
    };
  });
}

/** 移除成员（逐层下推；非叶子被拒并列出剩余从代理，决策项 10 / 18）。 */
export async function removeMember(
  host: GroupActionHost,
  args: Record<string, unknown>,
  caller: string,
): Promise<ActionResult> {
  return host.locked(caller, async () => {
    const book = await host.load(caller);
    if (book === undefined) return host.stateFailure();
    const groupName = stringArg(args, "group");
    const closed = host.closedGuard(book, groupName);
    if (closed !== undefined) return closed;
    const applied = modelRemoveMember(book, {
      group: groupName,
      name: stringArg(args, "name"),
      now: host.now(),
    });
    if (isFailure(applied)) return applied;
    const saved = await host.persist(applied.book);
    if (saved !== undefined) return saved;
    await host.mirrorGroup(applied.group);
    return {
      ok: true,
      action: "remove",
      group: groupName,
      removed: applied.removed.name,
      ...(applied.settled === undefined
        ? {}
        : { settledInstruction: applied.settled.id }),
      view: groupView(applied.group),
      next:
        applied.settled === undefined
          ? "成员已移除；用 status 查看剩余成员与连接"
          : "成员已移除，它连接上的未结指令已结算为失败（成因：成员已被移除）",
    };
  });
}
