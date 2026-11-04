/**
 * coagent/tests/probe.test.ts — 状态探测的判定表：终端是否还在、有没有前台进程、会话是否仍在线，
 * 以及「证据不足时不动记录」这条约束。
 *
 * 只用 fake 服务面，不落盘、不起宿主。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { findPeer, probeRecord } from "../src/probe.ts";
import type { CoagentRecord, ServiceContext } from "../src/types.ts";
import { FakeChannel } from "./fake-channel.ts";
import { FakeHerdr } from "./fake-herdr.ts";

const CONTEXT: ServiceContext = { session: { id: "sess-parent", cwd: "/tmp" } };

function recordOf(overrides: Partial<CoagentRecord> = {}): CoagentRecord {
  return {
    coagent_id: "c-00000001",
    state: "ready",
    cwd: "/tmp/work",
    label: "coagent-c-00000001",
    terminal_label: "coagent/c-00000001",
    cmd: "fffdsh",
    started_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    terminal_id: "t1",
    session_id: "sess-child",
    ...overrides,
  };
}

/** 起一对假服务面；`running` 决定 `info` 看到的终端状态。 */
function faces(running: boolean): { herdr: FakeHerdr; channel: FakeChannel } {
  const herdr = new FakeHerdr();
  herdr.terminals.set("t1", {
    terminalId: "t1",
    label: "coagent/c-00000001",
    cwd: "/tmp/work",
    foreground: true,
    running,
  });
  const channel = new FakeChannel();
  return { herdr, channel };
}

test("探测: 终端已标记关闭或缺 terminal_id 时不调服务面，原样返回", async () => {
  const { herdr, channel } = faces(true);
  const deps = { herdr, channel, context: CONTEXT };

  const closed = await probeRecord(
    deps,
    recordOf({ terminal_closed: true, state: "closing" }),
  );
  assert.deepEqual(closed, { state: "closing" });

  const noTerminal = await probeRecord(
    deps,
    recordOf({ terminal_id: undefined }),
  );
  assert.deepEqual(noTerminal, { state: "ready" });
  assert.equal(herdr.countOf("info"), 0);
  assert.equal(channel.peerCalls, 0);
});

test("探测: 终端未登记 → lost 且 terminal_running=false", async () => {
  const { herdr, channel } = faces(true);
  herdr.terminals.delete("t1");

  const outcome = await probeRecord(
    { herdr, channel, context: CONTEXT },
    recordOf({ state: "starting" }),
  );

  assert.deepEqual(outcome, { state: "lost", terminal_running: false });
});

test("探测: herdr 暂时不可用（非 terminal-not-registered）不改状态", async () => {
  const { herdr, channel } = faces(true);
  herdr.infoError = { code: "herdr-cli-error", message: "herdr 未运行" };

  const outcome = await probeRecord(
    { herdr, channel, context: CONTEXT },
    recordOf({ state: "ready" }),
  );

  assert.deepEqual(outcome, { state: "ready" });
  assert.equal(channel.peerCalls, 0);
});

test("探测: 有前台进程 → 保持原状态并带 terminal_running=true", async () => {
  const { herdr, channel } = faces(true);

  const outcome = await probeRecord(
    { herdr, channel, context: CONTEXT },
    recordOf({ state: "starting" }),
  );

  assert.deepEqual(outcome, { state: "starting", terminal_running: true });
});

test("探测: 无前台进程但会话还在线 → 保持原状态", async () => {
  const { herdr, channel } = faces(false);
  channel.addPeer({ sessionId: "sess-child", cwd: "/tmp/work" });

  const outcome = await probeRecord(
    { herdr, channel, context: CONTEXT },
    recordOf({ state: "ready" }),
  );

  assert.deepEqual(outcome, { state: "ready", terminal_running: false });
});

test("探测: peers 读失败 → 证据不足，保留原状态", async () => {
  const { herdr, channel } = faces(false);
  channel.fail = true;

  const outcome = await probeRecord(
    { herdr, channel, context: CONTEXT },
    recordOf({ state: "ready" }),
  );

  assert.deepEqual(outcome, { state: "ready", terminal_running: false });
});

test("探测: 无前台进程且会话已掉线 → lost", async () => {
  const { herdr, channel } = faces(false);
  channel.addPeer({ sessionId: "sess-other", cwd: "/tmp/work" });

  const outcome = await probeRecord(
    { herdr, channel, context: CONTEXT },
    recordOf({ state: "ready" }),
  );

  assert.deepEqual(outcome, { state: "lost", terminal_running: false });
});

test("探测: 没有 session_id 时只凭进程判 lost；已 closed 的记录保持 closed", async () => {
  const { herdr, channel } = faces(false);
  const deps = { herdr, channel, context: CONTEXT };

  const lost = await probeRecord(deps, recordOf({ session_id: undefined }));
  assert.deepEqual(lost, { state: "lost", terminal_running: false });

  const closed = await probeRecord(
    deps,
    recordOf({ session_id: undefined, state: "closed" }),
  );
  assert.deepEqual(closed, { state: "closed", terminal_running: false });
  assert.equal(channel.peerCalls, 0);
});

test("findPeer: 区分「peers 读失败」与「会话不在线」", async () => {
  const channel = new FakeChannel();
  channel.addPeer({ sessionId: "sess-child", cwd: "/tmp/work" });

  const online = await findPeer(channel, "sess-child");
  assert.deepEqual(online, {
    known: true,
    peer: { sessionId: "sess-child", cwd: "/tmp/work" },
  });

  const offline = await findPeer(channel, "sess-gone");
  assert.deepEqual(offline, { known: true, peer: undefined });

  channel.fail = true;
  assert.deepEqual(await findPeer(channel, "sess-child"), { known: false });
});
