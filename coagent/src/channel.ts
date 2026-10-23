/**
 * src/channel.ts — 认领新会话：轮询 session-channel 的 `peers()`，按 profile + cwd + 启动时刻
 * 匹配，并用「不在已有记录里」排除旧会话；同时取屏找 `fffdsh` 自己的报错（快速失败）。
 *
 * 为什么必须轮询（调研 §4）：session-channel 不做启动枚举、事件无回放，子会话要先产生第一条
 * `session/event` 才进 `peers`；`fffdsh` 首次启动还可能触发多包构建。因此认领超时按分钟级
 * 假设（缺省 180 s），且屏文本是唯一能区分「`fffdsh` 自己失败」与「会话没被认领」的证据。
 */

import type { Clock, PeerLike, SessionChannelFace } from "./types.ts";

/** 启动时刻容差：子进程 pid 的 `startedAt` 理论上晚于本包提交命令的时刻，留 5 s 抗抖动。 */
const STARTED_AT_TOLERANCE_MS = 5000;

/** 认领匹配条件。 */
export interface ClaimCriteria {
  /** 终端的启动目录（绝对路径）。 */
  cwd: string;
  /** 本进程的 profile（空串 = 未知，不参与匹配）。 */
  profile: string;
  /** 提交 `fffdsh` 的时刻（epoch ms）。 */
  startedAt: number;
  /** 已有记录里的会话 id（排除旧会话，避免认错）。 */
  known: ReadonlySet<string>;
}

/** 归一化目录（去尾斜杠；空串保持空串）。 */
function normalizeCwd(cwd: string | undefined): string {
  if (cwd === undefined) return "";
  return cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
}

/**
 * 在 `peers` 里挑出本包刚起的会话：
 * - 不在 `known` 里；
 * - `startedAt` 不早于 `criteria.startedAt`（容差 5 s；缺失时不判）；
 * - `profile` 两边都非空时必须相同（空串 = 未知，放行）；
 * - `cwd` 两边都非空时必须相同（空串 = 未知，放行）。
 * 多条命中取最早启动的那条（同一终端只可能起一个会话，多命中通常是同 cwd 并发拉起）。
 */
export function matchPeer(
  peers: readonly PeerLike[],
  criteria: ClaimCriteria,
): PeerLike | undefined {
  const wantedCwd = normalizeCwd(criteria.cwd);
  const matches = peers.filter((peer) => {
    if (criteria.known.has(peer.sessionId)) return false;
    if (
      peer.startedAt !== undefined &&
      peer.startedAt < criteria.startedAt - STARTED_AT_TOLERANCE_MS
    ) {
      return false;
    }
    const peerProfile = peer.profile ?? "";
    if (
      criteria.profile !== "" &&
      peerProfile !== "" &&
      peerProfile !== criteria.profile
    ) {
      return false;
    }
    const peerCwd = normalizeCwd(peer.cwd);
    if (wantedCwd !== "" && peerCwd !== "" && peerCwd !== wantedCwd) {
      return false;
    }
    return true;
  });
  matches.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return matches[0];
}

/** 屏文本里的快速失败证据（命中即 `launch_failed`，不等认领超时）。 */
export const SCREEN_FAILURES: ReadonlyArray<{
  pattern: RegExp;
  reason: string;
  next: string;
}> = [
  {
    pattern: /fffdsh: 环境中缺少\s*API_KEY/,
    reason:
      "`fffdsh` 前置检查失败：终端的 shell 环境里没有 `*_API_KEY`（dsh 根本没有启动）",
    next: "在 shell rc（如 ~/.bashrc / ~/.zshrc）里导出 API key，再重开终端；当前终端已回滚关闭",
  },
  {
    pattern: /(?:fffdsh: )?(?:command )?not found/i,
    reason:
      "终端里找不到 `fffdsh`：登录 shell 没有加载该函数（或不是 bash / zsh）",
    next: "确认终端的登录 shell 会加载 `fffdsh`（`bash -ic 'type fffdsh'` 能拿到函数）",
  },
];

/** 判屏文本是否已有失败证据。 */
export function screenFailureOf(
  screen: string,
): { reason: string; next: string } | undefined {
  for (const failure of SCREEN_FAILURES) {
    if (failure.pattern.test(screen)) {
      return { reason: failure.reason, next: failure.next };
    }
  }
  return undefined;
}

/** 认领请求。 */
export interface ClaimRequest {
  channel: SessionChannelFace;
  clock: Clock;
  criteria: ClaimCriteria;
  /** 认领上限毫秒（`claimTimeoutSec * 1000`）。 */
  timeoutMs: number;
  /** 轮询间隔毫秒。 */
  pollIntervalMs: number;
  /** 取屏（失败时返回 `undefined`，不中断认领）。 */
  readScreen: () => Promise<string | undefined>;
  /** 认领日志（写 `claim.log`；每轮一行）。 */
  log?: (line: string) => void;
}

/** 认领结果。 */
export type ClaimResult =
  | { kind: "claimed"; peer: PeerLike }
  | {
      kind: "screen-failed";
      reason: string;
      next: string;
      screen: string;
    }
  | {
      kind: "timeout";
      reason: string;
      attempts: number;
      screen?: string;
    };

/** 认领超时的原因清单（回执与 `claim.log` 共用；F6 要求列可能原因）。 */
export const CLAIM_TIMEOUT_REASONS: readonly string[] = [
  "`fffdsh` 首次启动可能在跑多包构建，耗时数分钟",
  "子会话所在 profile 没挂 session-channel，会话不会上线",
  "子会话还没产生第一条事件，或两边连的不是同一个 Redis 端点",
];

/** 轮询直到认领成功、屏上报错、或超时。 */
export async function claimSession(
  request: ClaimRequest,
): Promise<ClaimResult> {
  const { channel, clock, criteria, timeoutMs, pollIntervalMs } = request;
  const startedAt = clock.now();
  const deadline = startedAt + timeoutMs;
  const log = request.log ?? (() => undefined);
  let attempts = 0;
  let lastScreen: string | undefined;

  for (;;) {
    attempts += 1;
    const listed = await channel.peers();
    if (listed.ok) {
      const match = matchPeer(listed.peers ?? [], criteria);
      if (match !== undefined) {
        log(
          `[+${clock.now() - startedAt}ms] 第 ${attempts} 轮认领到会话 ${match.sessionId}` +
            (match.pid === undefined ? "" : `（pid ${match.pid}）`),
        );
        return { kind: "claimed", peer: match };
      }
      log(
        `[+${clock.now() - startedAt}ms] 第 ${attempts} 轮：peers 共 ${listed.peers?.length ?? 0} 条，无匹配`,
      );
    } else {
      log(
        `[+${clock.now() - startedAt}ms] 第 ${attempts} 轮：peers 读取失败（${listed.error ?? "未知原因"}）`,
      );
    }

    const screen = await request.readScreen();
    if (screen !== undefined && screen !== "") {
      lastScreen = screen;
      const failed = screenFailureOf(screen);
      if (failed !== undefined) {
        log(
          `[+${clock.now() - startedAt}ms] 屏上出现失败证据：${failed.reason}`,
        );
        return {
          kind: "screen-failed",
          reason: failed.reason,
          next: failed.next,
          screen,
        };
      }
    }

    if (clock.now() >= deadline) break;
    await clock.sleep(pollIntervalMs);
    // 假时钟可能一跳越过 deadline；下一轮开头还有一次 peers 机会，这里只在越过时收敛。
    if (clock.now() >= deadline) break;
    // 防御：时钟不推进（注入错误）时不让循环无限转。
    if (attempts >= 10_000) break;
  }

  log(
    `[+${clock.now() - startedAt}ms] 认领超时（${Math.round(timeoutMs / 1000)}s，${attempts} 轮）`,
  );
  return {
    kind: "timeout",
    reason: `认领超时（${Math.round(timeoutMs / 1000)}s）：peers 里没有匹配的新会话。可能原因：${CLAIM_TIMEOUT_REASONS.map(
      (item, index) => `${index + 1}）${item}`,
    ).join("；")}`,
    attempts,
    ...(lastScreen === undefined ? {} : { screen: lastScreen }),
  };
}
