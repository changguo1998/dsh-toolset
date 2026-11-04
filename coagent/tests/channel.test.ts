/**
 * coagent/tests/channel.test.ts — 认领判定的锚点：`matchPeer` 的四个过滤条件、屏文本快速失败的两条
 * pattern，以及 `claimSession` 的三种结局与日志。
 *
 * 时间用 `ManualClock`，服务面用 fake；不落盘、不起宿主。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { claimSession, matchPeer, screenFailureOf } from "../src/channel.ts";
import type { ClaimCriteria } from "../src/channel.ts";
import { FakeChannel } from "./fake-channel.ts";
import { ManualClock } from "./fake-clock.ts";

const STARTED_AT = 1_700_000_000_000;

function criteriaOf(overrides: Partial<ClaimCriteria> = {}): ClaimCriteria {
  return {
    cwd: "/tmp/work",
    profile: "fff",
    startedAt: STARTED_AT,
    known: new Set<string>(),
    ...overrides,
  };
}

test("matchPeer: 排除已有记录里的会话（防认错旧会话）", () => {
  const peers = [
    {
      sessionId: "sess-old",
      cwd: "/tmp/work",
      profile: "fff",
      startedAt: STARTED_AT,
    },
    {
      sessionId: "sess-new",
      cwd: "/tmp/work",
      profile: "fff",
      startedAt: STARTED_AT,
    },
  ];

  const matched = matchPeer(
    peers,
    criteriaOf({ known: new Set(["sess-old"]) }),
  );

  assert.equal(matched?.sessionId, "sess-new");
});

test("matchPeer: 启动时刻早于容差（5 s）的会话不认", () => {
  const peers = [
    {
      sessionId: "sess-stale",
      cwd: "/tmp/work",
      profile: "fff",
      startedAt: STARTED_AT - 5001,
    },
    {
      sessionId: "sess-edge",
      cwd: "/tmp/work",
      profile: "fff",
      startedAt: STARTED_AT - 5000,
    },
  ];

  const matched = matchPeer(peers, criteriaOf());

  assert.equal(matched?.sessionId, "sess-edge", "正好 5 s 仍在容差内");
});

test("matchPeer: 缺 startedAt 时不判时间", () => {
  const matched = matchPeer(
    [{ sessionId: "sess-unknown", cwd: "/tmp/work", profile: "fff" }],
    criteriaOf(),
  );
  assert.equal(matched?.sessionId, "sess-unknown");
});

test("matchPeer: profile 与 cwd 两边都非空时必须相同，空串视为未知放行", () => {
  const peers = [
    {
      sessionId: "sess-other-profile",
      cwd: "/tmp/work",
      profile: "ggg",
      startedAt: STARTED_AT,
    },
    {
      sessionId: "sess-other-cwd",
      cwd: "/tmp/elsewhere",
      profile: "fff",
      startedAt: STARTED_AT,
    },
    { sessionId: "sess-no-profile", cwd: "/tmp/work", startedAt: STARTED_AT },
  ];

  const matched = matchPeer(peers, criteriaOf());
  assert.equal(matched?.sessionId, "sess-no-profile");

  // 本进程 profile 未知（空串）：不按 profile 过滤。
  const unknownProfile = matchPeer(
    [
      {
        sessionId: "sess-fff",
        cwd: "/tmp/work",
        profile: "fff",
        startedAt: STARTED_AT,
      },
    ],
    criteriaOf({ profile: "" }),
  );
  assert.equal(unknownProfile?.sessionId, "sess-fff");
});

test("matchPeer: cwd 尾斜杠归一后再比；多条命中取最早启动的那条", () => {
  const peers = [
    {
      sessionId: "sess-late",
      cwd: "/tmp/work/",
      profile: "fff",
      startedAt: STARTED_AT + 2000,
    },
    {
      sessionId: "sess-early",
      cwd: "/tmp/work",
      profile: "fff",
      startedAt: STARTED_AT + 1000,
    },
  ];

  const matched = matchPeer(peers, criteriaOf({ cwd: "/tmp/work/" }));

  assert.equal(matched?.sessionId, "sess-early");
  assert.equal(matchPeer([], criteriaOf()), undefined);
});

test("screenFailureOf: 缺 API_KEY 与 command not found 两条证据各给下一步", () => {
  const missingKey = screenFailureOf("fffdsh: 环境中缺少 API_KEY，请先导出");
  assert.match(missingKey?.reason ?? "", /没有 `\*_API_KEY`/);
  assert.match(missingKey?.next ?? "", /shell rc/);

  const notFound = screenFailureOf("bash: line 1: fffdsh: command not found");
  assert.match(notFound?.reason ?? "", /找不到 `fffdsh`/);
  assert.match(notFound?.next ?? "", /登录 shell/);

  assert.equal(screenFailureOf("一切正常"), undefined);
  assert.equal(screenFailureOf(""), undefined);
});

test("claimSession: 第一轮就命中 → claimed 并记一行带 pid 的日志", async () => {
  const channel = new FakeChannel();
  channel.addPeer({
    sessionId: "sess-child",
    pid: 4321,
    cwd: "/tmp/work",
    profile: "fff",
    startedAt: STARTED_AT,
  });
  const log: string[] = [];

  const result = await claimSession({
    channel,
    clock: new ManualClock(STARTED_AT),
    criteria: criteriaOf(),
    timeoutMs: 3000,
    pollIntervalMs: 1000,
    readScreen: async () => undefined,
    log: (line) => log.push(line),
  });

  assert.equal(result.kind, "claimed");
  assert.equal(
    result.kind === "claimed" ? result.peer.sessionId : undefined,
    "sess-child",
  );
  assert.equal(channel.peerCalls, 1);
  assert.equal(log.length, 1);
  assert.match(log[0] ?? "", /第 1 轮认领到会话 sess-child/);
  assert.match(log[0] ?? "", /pid 4321/);
});

test("claimSession: peers 读失败也继续轮询，下一轮命中后返回 claimed", async () => {
  const channel = new FakeChannel();
  channel.fail = true;
  const clock = new ManualClock(STARTED_AT);
  const log: string[] = [];
  let sleeps = 0;
  clock.onSleep(() => {
    sleeps += 1;
    channel.fail = false;
    channel.addPeer({
      sessionId: "sess-child",
      cwd: "/tmp/work",
      profile: "fff",
      startedAt: clock.now(),
    });
  });

  const result = await claimSession({
    channel,
    clock,
    criteria: criteriaOf(),
    timeoutMs: 3000,
    pollIntervalMs: 1000,
    readScreen: async () => "",
    log: (line) => log.push(line),
  });

  assert.equal(result.kind, "claimed");
  assert.equal(sleeps, 1);
  assert.match(log[0] ?? "", /peers 读取失败/);
  assert.match(log[1] ?? "", /无匹配|认领到会话/);
});

test("claimSession: 屏上出现失败证据 → screen-failed，不等超时", async () => {
  const channel = new FakeChannel();

  const result = await claimSession({
    channel,
    clock: new ManualClock(STARTED_AT),
    criteria: criteriaOf(),
    timeoutMs: 3000,
    pollIntervalMs: 1000,
    readScreen: async () => "fffdsh: 环境中缺少 API_KEY",
  });

  assert.equal(result.kind, "screen-failed");
  assert.match(result.kind === "screen-failed" ? result.reason : "", /API_KEY/);
  assert.match(result.kind === "screen-failed" ? result.screen : "", /API_KEY/);
  assert.equal(channel.peerCalls, 1);
});

test("claimSession: 超时 → timeout，回执列全部可能原因并带上最后一次屏文本", async () => {
  const channel = new FakeChannel();
  const clock = new ManualClock(STARTED_AT);
  const log: string[] = [];

  const result = await claimSession({
    channel,
    clock,
    criteria: criteriaOf(),
    timeoutMs: 2000,
    pollIntervalMs: 1000,
    readScreen: async () => "  ",
    log: (line) => log.push(line),
  });

  assert.equal(result.kind, "timeout");
  if (result.kind !== "timeout") return;
  assert.ok(result.attempts >= 2, `轮次异常：${result.attempts}`);
  assert.match(result.reason, /认领超时/);
  assert.match(result.reason, /构建/, "要列出「首次构建耗时」这条原因");
  assert.match(result.reason, /没挂 session-channel/);
  assert.match(result.reason, /同一个 Redis 端点/);
  assert.equal(result.screen, "  ");
  assert.match(log[log.length - 1] ?? "", /认领超时/);
});

test("claimSession: 没有任何屏文本时回执不带 screen", async () => {
  const result = await claimSession({
    channel: new FakeChannel(),
    clock: new ManualClock(STARTED_AT),
    criteria: criteriaOf(),
    timeoutMs: 1000,
    pollIntervalMs: 1000,
    readScreen: async () => undefined,
  });

  assert.equal(result.kind, "timeout");
  assert.equal(result.kind === "timeout" ? result.screen : "x", undefined);
});
