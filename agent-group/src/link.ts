/**
 * 连接层: 主从连接 / 平等连接的建立, 以及经连接的「发完即走」通知（send_peer / broadcast）。
 *
 * 通知语义不产生未结指令; 需要回报的任务走指令与结算层（`src/instruction.ts`）。
 */

import { stringArg, type GroupActionHost } from "./action-host.ts";
import {
  failure,
  groupView,
  isFailure,
  linkMembers as modelLinkMembers,
  linkPeer as modelLinkPeer,
  MANAGER_NAME,
  membersOf,
  peerPairKey,
  pickGroup,
} from "./model.ts";
import type { ActionResult } from "./types.ts";

/** 建立主从连接（主 → 从；从方须自由代理，等级 = 主 + 1，决策项 9）。 */
export async function link(
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
    const applied = modelLinkMembers(book, {
      group: groupName,
      from: stringArg(args, "from"),
      to: stringArg(args, "to"),
      now: host.now(),
    });
    if (isFailure(applied)) return applied;
    const saved = await host.persist(applied.book);
    if (saved !== undefined) return saved;
    await host.mirrorGroup(applied.group);
    return {
      ok: true,
      action: "link",
      group: groupName,
      from: applied.link.from,
      to: applied.link.to,
      level: applied.link.level,
      view: groupView(applied.group),
      next: `发指令：send group=${groupName} to=${applied.link.to} text=<正文>（每连接同时只允许一条未结）`,
    };
  });
}

/** 建立平等连接（双向、无等级；每对 agent 每种连接至多一条，决策项 4 / 6）。 */
export async function linkPeer(
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
    const applied = modelLinkPeer(book, {
      group: groupName,
      from: stringArg(args, "from"),
      to: stringArg(args, "to"),
      now: host.now(),
    });
    if (isFailure(applied)) return applied;
    const saved = await host.persist(applied.book);
    if (saved !== undefined) return saved;
    await host.mirrorGroup(applied.group);
    return {
      ok: true,
      action: "link_peer",
      group: groupName,
      link: {
        from: applied.link.from,
        to: applied.link.to,
        createdAt: applied.link.createdAt,
      },
      view: groupView(applied.group),
      next: `经该平等连接发消息：send_peer group=${groupName} to=<另一端> text=<正文>（发完即走，无未结）`,
    };
  });
}

/** 经平等连接发一条「发完即走」的消息（决策项 6：不等回复、不重试、不留状态）。 */
export async function sendPeer(
  host: GroupActionHost,
  args: Record<string, unknown>,
  caller: string,
): Promise<ActionResult> {
  const book = await host.load(caller);
  if (book === undefined) return host.stateFailure();
  const groupName = stringArg(args, "group");
  const closed = host.closedGuard(book, groupName);
  if (closed !== undefined) return closed;
  const to = stringArg(args, "to");
  const text = stringArg(args, "text").trim();
  const found = pickGroup(book, groupName);
  if (isFailure(found)) return found;
  const target = found.members[to];
  if (target === undefined) {
    return {
      ...failure(
        "member_not_found",
        `组里没有成员「${to}」`,
        `现有成员：${membersOf(found).join(", ")}`,
      ),
      action: "send_peer",
      group: groupName,
    };
  }
  if (text === "") {
    return {
      ...failure(
        "invalid_argument",
        "消息正文不能为空",
        "text 写清要对方看什么（平等连接为通知语义，不产生未结指令）",
      ),
      action: "send_peer",
      group: groupName,
    };
  }
  const key = peerPairKey(MANAGER_NAME, to);
  if (found.peerLinks[key] === undefined) {
    return {
      ...failure(
        "no_peer_link",
        `「${MANAGER_NAME}」与「${to}」之间没有平等连接`,
        `先 link_peer group=${groupName} from=${MANAGER_NAME} to=${to}`,
      ),
      action: "send_peer",
      group: groupName,
    };
  }
  const sent = await host.guard("经平等连接发送", () =>
    host.transport.sendMessage({ to: target.sessionId, text }),
  );
  if (isFailure(sent)) {
    return {
      ...sent,
      action: "send_peer",
      group: groupName,
      to,
    };
  }
  return {
    ok: true,
    action: "send_peer",
    group: groupName,
    from: MANAGER_NAME,
    to,
    delivered: sent.delivered,
    next: "发完即走，无未结指令；用 status 查看组成员与连接",
  };
}

/** 广播：按当前成员集合逐条发送并汇总送达 / 失败（决策项 13 / 20）。 */
export async function broadcast(
  host: GroupActionHost,
  args: Record<string, unknown>,
  caller: string,
): Promise<ActionResult> {
  const book = await host.load(caller);
  if (book === undefined) return host.stateFailure();
  const groupName = stringArg(args, "group");
  const closed = host.closedGuard(book, groupName);
  if (closed !== undefined) return closed;
  const text = stringArg(args, "text").trim();
  const found = pickGroup(book, groupName);
  if (isFailure(found))
    return { ...found, action: "broadcast", group: groupName };
  if (text === "") {
    return {
      ...failure(
        "invalid_argument",
        "广播正文不能为空",
        "text 写清要成员们看什么（广播为通知语义，不产生未结指令）",
      ),
      action: "broadcast",
      group: groupName,
    };
  }
  const requested = stringArg(args, "to");
  const targets =
    requested === ""
      ? membersOf(found).filter((name) => name !== MANAGER_NAME)
      : [
          ...new Set(
            requested
              .split(/[,，\s]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ];
  for (const name of targets) {
    if (found.members[name] === undefined) {
      return {
        ...failure(
          "member_not_found",
          `组里没有成员「${name}」`,
          `现有成员：${membersOf(found).join(", ")}；广播目标用逗号或空格分隔`,
        ),
        action: "broadcast",
        group: groupName,
      };
    }
  }
  const results: Array<Record<string, unknown>> = [];
  let delivered = 0;
  for (const name of targets) {
    const member = found.members[name];
    if (member === undefined || member.role === "manager") {
      results.push({ to: name, delivered: false, error: "manager_skip" });
      continue;
    }
    const sent = await host.guard("广播发送", () =>
      host.transport.sendMessage({ to: member.sessionId, text }),
    );
    if (isFailure(sent)) {
      results.push({
        to: name,
        delivered: false,
        error: sent.error,
        ...(sent.reason === undefined ? {} : { reason: sent.reason }),
      });
    } else {
      if (sent.delivered) delivered += 1;
      results.push({ to: name, delivered: sent.delivered });
    }
  }
  return {
    ok: true,
    action: "broadcast",
    group: groupName,
    targets,
    results,
    delivery: {
      targets: results.length,
      delivered,
      failed: results.length - delivered,
    },
    next: "广播为发完即走通知，无未结指令；需要回报的任务请用主从 send / check",
  };
}
