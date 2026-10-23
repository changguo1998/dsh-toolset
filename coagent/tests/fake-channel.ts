/**
 * tests/fake-channel.ts — fake session-channel 服务面（只实现 `peers` 与可选 `statusOf`）。
 *
 * 认领相关用例的套路：先空列表，在 `sleep` 回调里 `addPeer`，让下一轮轮询命中。
 */

import type { PeerLike, SessionChannelFace } from "../src/types.ts";

export class FakeChannel implements SessionChannelFace {
  peersList: PeerLike[] = [];
  /** true = `peers` 读失败（Redis 不可用）。 */
  fail = false;
  peerCalls = 0;

  addPeer(peer: PeerLike): void {
    this.peersList.push(peer);
  }

  removePeer(sessionId: string): void {
    this.peersList = this.peersList.filter(
      (peer) => peer.sessionId !== sessionId,
    );
  }

  async peers(): Promise<{
    ok: boolean;
    peers?: PeerLike[];
    error?: string;
  }> {
    this.peerCalls += 1;
    if (this.fail) return { ok: false, error: "Redis 不可用（假故障）" };
    return { ok: true, peers: this.peersList.map((peer) => ({ ...peer })) };
  }

  async statusOf(sessionId: string): Promise<{
    ok: boolean;
    state?: { status: "idle" | "running"; at: number };
    error?: string;
  }> {
    if (!this.peersList.some((peer) => peer.sessionId === sessionId)) {
      return { ok: false, error: "会话不在线" };
    }
    return { ok: true, state: { status: "idle", at: 0 } };
  }
}
