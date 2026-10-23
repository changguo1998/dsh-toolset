/**
 * src/probe.ts — 状态探测：终端是否存在 / 是否有前台进程 / 会话是否还在 `peers` 里在线。
 *
 * 证据优先级（决策项 8）：屏文本 > `peers` 在线 > 终端存在性 > 时间。
 * `list(probe=live)` 只做廉价核对：`info` 一次 + `peers` 一次；不读屏（读屏留给排障的人）。
 * 只有「确定消失」的证据（`terminal-not-registered`，或掉线且无前台进程）才把记录推进到
 * `lost`；服务暂时不可用（herdr 报错 / `peers` 读失败）不改状态，只把 `terminal_running`
 * 留成未知。
 */

import { runningOf, isTerminalGone } from "./herdr.ts";
import type {
  CoagentRecord,
  CoagentState,
  HerdrUseFace,
  PeerLike,
  ProbeOutcome,
  ServiceContext,
  SessionChannelFace,
} from "./types.ts";

/** 探测所需的两个服务面与会话上下文。 */
export interface ProbeDeps {
  herdr: HerdrUseFace;
  channel: SessionChannelFace;
  context: ServiceContext;
}

/** 找某会话的在线对端（`peers` 读失败时返回 `undefined`，与「不在线」区分开）。 */
export async function findPeer(
  channel: SessionChannelFace,
  sessionId: string,
): Promise<{ known: boolean; peer?: PeerLike }> {
  const listed = await channel.peers();
  if (!listed.ok) return { known: false };
  return {
    known: true,
    peer: (listed.peers ?? []).find((item) => item.sessionId === sessionId),
  };
}

/**
 * 探测一条记录：返回应落的新状态（终态记录不探测，原样返回）。
 *
 * - `info` 报 `terminal-not-registered` → `lost`（终端被关 / 崩溃残留被清理）；
 * - `info` 成功且 `running: true` → 保持原状态（`starting` 不会因此变 `ready`，认领只由
 *   `spawn` 做）；
 * - `running: false` 且会话仍在线 → 保持原状态（可能处在上层重启 / 构建间隙）；
 * - `running: false` 且会话不在线（或没有 `session_id`）→ `lost`。
 */
export async function probeRecord(
  deps: ProbeDeps,
  record: CoagentRecord,
): Promise<ProbeOutcome> {
  if (record.terminal_closed === true || record.terminal_id === undefined) {
    return { state: record.state };
  }

  const info = await deps.herdr.info(record.terminal_id, deps.context);
  if (isTerminalGone(info)) {
    return { state: "lost", terminal_running: false };
  }
  if (!info.ok) {
    // herdr 暂时不可用：不改状态（避免把「连不上」误判成「终端没了」）。
    return { state: record.state };
  }

  const running = runningOf(info);
  if (running === true) {
    return { state: record.state, terminal_running: true };
  }

  // running === false（或缺失）：用 peers 决定「还在启动」还是「真没了」。
  if (record.session_id !== undefined) {
    const peer = await findPeer(deps.channel, record.session_id);
    if (!peer.known) {
      // peers 读失败：证据不足，保留原状态。
      return { state: record.state, terminal_running: running };
    }
    if (peer.peer !== undefined) {
      return { state: record.state, terminal_running: running };
    }
  }

  const next: CoagentState = record.state === "closed" ? "closed" : "lost";
  return { state: next, terminal_running: false };
}
