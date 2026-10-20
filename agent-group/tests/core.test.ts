/**
 * 动作层单测（假传输 + 内存存储）：7 个动作的编排、每连接一条未结、懒判定三收场、
 * 拒绝路径、存储 / 镜像 / 传输失败时的降级，以及同会话串行。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GroupService,
  readGroupStatus,
  resolveConfig,
  verdictOf,
} from "../src/core.ts";
import { failure, isFailure } from "../src/model.ts";
import { MemoryBookStore } from "../src/store.ts";
import type {
  ActionResult,
  GroupFailure,
  GroupInstruction,
  GroupMirror,
  GroupTransport,
  GroupView,
  TaskSnapshot,
} from "../src/types.ts";

const MANAGER = "sess-manager";

/** 假传输：解析表 + 任务表，可注入失败。 */
class FakeTransport implements GroupTransport {
  readonly resolutions = new Map<string, string>();
  readonly tasks = new Map<string, TaskSnapshot>();
  readonly delegated: Array<{
    from: string;
    to: string;
    text: string;
    timeoutSec: number;
    taskId: string;
  }> = [];
  delegateFailure: GroupFailure | undefined;
  statusFailure: GroupFailure | undefined;
  /** 发完即走消息记录（`send` 面）。 */
  readonly sent: Array<{ to: string; text: string }> = [];
  sendFailure: GroupFailure | undefined;
  sendDelivered = true;

  async resolve(
    target: string,
  ): Promise<{ ok: true; sessionId: string } | GroupFailure> {
    const sessionId = this.resolutions.get(target);
    if (sessionId === undefined) {
      return failure(
        "target_offline",
        `目标不在线或不存在：${target}`,
        "用 session_channel peers 确认在线目标",
      );
    }
    return { ok: true, sessionId };
  }

  async delegate(input: {
    from: string;
    to: string;
    text: string;
    timeoutSec: number;
  }): Promise<{ ok: true; taskId: string } | GroupFailure> {
    if (this.delegateFailure !== undefined) return this.delegateFailure;
    const taskId = `task-${this.delegated.length + 1}`;
    this.delegated.push({ ...input, taskId });
    this.tasks.set(taskId, { status: "running" });
    return { ok: true, taskId };
  }

  async sendMessage(input: {
    to: string;
    text: string;
  }): Promise<{ ok: true; delivered: boolean } | GroupFailure> {
    if (this.sendFailure !== undefined) return this.sendFailure;
    this.sent.push(input);
    return { ok: true, delivered: this.sendDelivered };
  }

  async taskStatus(
    taskId: string,
  ): Promise<{ ok: true; task: TaskSnapshot } | GroupFailure> {
    if (this.statusFailure !== undefined) return this.statusFailure;
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return failure("task_not_found", `任务记录不存在：${taskId}`, "重发");
    }
    return { ok: true, task };
  }
}

/** 假镜像：记录写入的视图，可注入失败。 */
class FakeMirror implements GroupMirror {
  readonly puts: GroupView[] = [];
  fail = false;

  async put(input: { view: GroupView }): Promise<void> {
    if (this.fail) throw new Error("memory-base 拒收（preWrite）");
    this.puts.push(input.view);
  }
}

/** 起一套被测环境（时钟与 id 可预测）。 */
function setup() {
  const store = new MemoryBookStore();
  const transport = new FakeTransport();
  const mirror = new FakeMirror();
  let clock = 1_000_000;
  let sequence = 0;
  const service = new GroupService({
    store,
    transport,
    mirror,
    config: resolveConfig({ defaultTimeoutMs: 60_000 }),
    now: () => clock,
    newId: () => `id-${(sequence += 1)}`,
    log: () => {},
  });
  return {
    service,
    store,
    transport,
    mirror,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function expectFailure(result: ActionResult): GroupFailure {
  assert.equal(result.ok, false, `应为拒绝：${JSON.stringify(result)}`);
  const failed = result as GroupFailure;
  assert.notEqual(failed.reason, "");
  assert.notEqual(failed.next, "");
  return failed;
}

/** 起手：组 team + alice / bob 两个成员 + manager → alice 的连接。 */
async function ready() {
  const env = setup();
  env.transport.resolutions.set("alice-alias", "sess-alice");
  env.transport.resolutions.set("sess-bob", "sess-bob");
  const created = await env.service.createGroup({ name: "team" }, MANAGER);
  assert.equal(created.ok, true, JSON.stringify(created));
  const addedAlice = await env.service.addMember(
    { group: "team", name: "alice", target: "alice-alias" },
    MANAGER,
  );
  assert.equal(addedAlice.ok, true, JSON.stringify(addedAlice));
  assert.equal(addedAlice["sessionId"], "sess-alice");
  const addedBob = await env.service.addMember(
    { group: "team", name: "bob", target: "sess-bob" },
    MANAGER,
  );
  assert.equal(addedBob.ok, true, JSON.stringify(addedBob));
  const linked = await env.service.link(
    { group: "team", from: "manager", to: "alice" },
    MANAGER,
  );
  assert.equal(linked.ok, true, JSON.stringify(linked));
  return env;
}

test("全流程：建组 → 加成员 → 建连接 → 发指令 → check 收回报 → status → remove", async () => {
  const env = await ready();
  const sent = await env.service.send(
    { group: "team", to: "alice", text: "写一份设计" },
    MANAGER,
  );
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent["taskId"], "task-1");
  const instruction = sent["instructionId"];
  assert.equal(typeof instruction, "string");
  assert.equal(env.transport.delegated.length, 1);
  assert.deepEqual(
    {
      from: env.transport.delegated[0]?.from,
      to: env.transport.delegated[0]?.to,
      timeoutSec: env.transport.delegated[0]?.timeoutSec,
    },
    { from: MANAGER, to: "sess-alice", timeoutSec: 60 },
  );
  assert.equal(
    env.mirror.puts.length,
    5,
    "每次变更（建组 / 加两次 / 连接 / 发指令）后镜像一次",
  );

  env.transport.tasks.set("task-1", { status: "done", result: "设计在这" });
  const checked = await env.service.check({ group: "team" }, MANAGER);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const settled = checked["settled"] as Array<Record<string, unknown>>;
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.["status"], "success");
  assert.equal(settled[0]?.["result"], "设计在这");
  assert.deepEqual(checked["open"], []);
  assert.deepEqual(checked["idle"], []);
  const view = checked["view"] as GroupView;
  assert.equal(view.summary.success, 1);
  assert.equal(view.summary.open, 0);

  const status = await env.service.status({ group: "team" }, MANAGER);
  assert.equal(status.ok, true);
  assert.equal(
    (status["view"] as GroupView).instructions[0]?.status,
    "success",
  );

  const removed = await env.service.remove(
    { group: "team", name: "bob" },
    MANAGER,
  );
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed["removed"], "bob");
  assert.deepEqual(
    (removed["view"] as GroupView).members.map((member) => member.name),
    ["manager", "alice"],
  );
});

test("加成员：目标离线被拒（带原因 + 下一步），且不落盘", async () => {
  const env = setup();
  await env.service.createGroup({ name: "team" }, MANAGER);
  const saves = env.store.saves;
  const failed = expectFailure(
    await env.service.addMember(
      { group: "team", name: "ghost", target: "nobody" },
      MANAGER,
    ),
  );
  assert.equal(failed.error, "target_offline");
  assert.match(failed.next, /peers/);
  assert.equal(env.store.saves, saves, "拒绝路径不落盘");
});

test("每连接同时只允许一条未结指令；并发发两条也只有一条成功", async () => {
  const env = await ready();
  const first = await env.service.send(
    { group: "team", to: "alice", text: "第一条" },
    MANAGER,
  );
  assert.equal(first.ok, true);
  const second = expectFailure(
    await env.service.send(
      { group: "team", to: "alice", text: "第二条" },
      MANAGER,
    ),
  );
  assert.equal(second.error, "instruction_open");
  assert.match(second.next, /check/);

  // 并发：锁把两条串起来，后到的那条看到前一条的未结指令
  const env2 = await ready();
  const [a, b] = await Promise.all([
    env2.service.send({ group: "team", to: "alice", text: "并发 1" }, MANAGER),
    env2.service.send({ group: "team", to: "alice", text: "并发 2" }, MANAGER),
  ]);
  const results = [a, b].sort((x, y) => Number(y.ok) - Number(x.ok));
  assert.equal(results[0]?.ok, true);
  assert.equal(results[1]?.ok, false);
  assert.equal((results[1] as GroupFailure).error, "instruction_open");
});

test("check 懒判定：成功 / 失败 / 受阻（blocked 前缀）/ 超时（通道与本地）", async () => {
  const cases: Array<{
    label: string;
    task: TaskSnapshot;
    advanceMs: number;
    status: string;
    cause?: string;
    result?: string;
  }> = [
    {
      label: "成功",
      task: { status: "done", result: "做完了" },
      advanceMs: 0,
      status: "success",
      result: "做完了",
    },
    {
      label: "失败",
      task: { status: "failed", error: "编译不过" },
      advanceMs: 0,
      status: "failure",
      cause: "编译不过",
    },
    {
      label: "受阻",
      task: { status: "failed", error: "blocked: 缺少凭据" },
      advanceMs: 0,
      status: "blocked",
      cause: "缺少凭据",
    },
    {
      label: "取消算失败",
      task: { status: "canceled" },
      advanceMs: 0,
      status: "failure",
      cause: "指令被取消",
    },
    {
      label: "通道判定超时",
      task: { status: "timeout" },
      advanceMs: 0,
      status: "timeout",
      cause: "超出等待上限（60000 ms，通道判定）",
    },
    {
      label: "本地判定超时",
      task: { status: "running" },
      advanceMs: 60_001,
      status: "timeout",
      cause: "超出等待上限（60000 ms，本地判定）",
    },
  ];
  for (const item of cases) {
    const env = await ready();
    const sent = await env.service.send(
      { group: "team", to: "alice", text: "任务" },
      MANAGER,
    );
    assert.equal(sent.ok, true, item.label);
    env.transport.tasks.set("task-1", item.task);
    env.tick(item.advanceMs);
    const checked = await env.service.check({ group: "team" }, MANAGER);
    assert.equal(checked.ok, true, item.label);
    const settled = checked["settled"] as Array<Record<string, unknown>>;
    assert.equal(settled.length, 1, `${item.label}：应结算一条`);
    assert.equal(settled[0]?.["status"], item.status, item.label);
    if (item.cause !== undefined) {
      assert.equal(settled[0]?.["cause"], item.cause, item.label);
    }
    if (item.result !== undefined) {
      assert.equal(settled[0]?.["result"], item.result, item.label);
    }
  }
});

test("check：未超时的运行中指令保持未结；任务记录丢失算失败；无指令算空闲", async () => {
  const env = await ready();
  await env.service.send({ group: "team", to: "alice", text: "任务" }, MANAGER);

  const running = await env.service.check(
    { group: "team", to: "alice" },
    MANAGER,
  );
  assert.deepEqual(running["settled"], []);
  assert.deepEqual(running["open"], ["alice"]);
  assert.deepEqual(running["idle"], []);

  env.transport.tasks.delete("task-1");
  const lost = await env.service.check({ group: "team" }, MANAGER);
  const settled = lost["settled"] as Array<Record<string, unknown>>;
  assert.equal(settled[0]?.["status"], "failure");
  assert.match(String(settled[0]?.["cause"]), /任务记录不存在/);

  const idle = await env.service.check({ group: "team" }, MANAGER);
  assert.deepEqual(idle["settled"], []);
  assert.deepEqual(idle["open"], []);
  assert.deepEqual(idle["idle"], ["alice"]);
  assert.deepEqual(lost["view"], idle["view"]);
});

test("check：无连接的成员（自由代理）算空闲；缺 to 时检查全组连接", async () => {
  const env = await ready();
  const idle = await env.service.check({ group: "team" }, MANAGER);
  assert.deepEqual(idle["idle"], ["alice"], "只有建立连接的成员参与检查");
  assert.deepEqual(idle["checked"], ["alice"]);
});

test("移除：非叶子被拒并列出剩余从代理；叶子移除会结算未结指令为 removed", async () => {
  const env = await ready();
  const chained = await env.service.link(
    { group: "team", from: "alice", to: "bob" },
    MANAGER,
  );
  assert.equal(chained.ok, true, JSON.stringify(chained));
  assert.equal(chained["level"], 2);

  const notLeaf = expectFailure(
    await env.service.remove({ group: "team", name: "alice" }, MANAGER),
  );
  assert.equal(notLeaf.error, "not_leaf");
  assert.deepEqual(notLeaf["subordinates"], ["bob"]);
  assert.match(notLeaf.next, /remove name=bob/);

  const sent = await env.service.send(
    { group: "team", to: "alice", text: "给 alice" },
    MANAGER,
  );
  assert.equal(sent.ok, true);
  const removedBob = await env.service.remove(
    { group: "team", name: "bob" },
    MANAGER,
  );
  assert.equal(removedBob.ok, true);
  const removedAlice = await env.service.remove(
    { group: "team", name: "alice" },
    MANAGER,
  );
  assert.equal(removedAlice.ok, true, JSON.stringify(removedAlice));
  assert.equal(typeof removedAlice["settledInstruction"], "string");
  const view = removedAlice["view"] as GroupView;
  assert.equal(view.summary.removed, 1);
  assert.equal(
    view.instructions.find((item) => item.status === "removed")?.cause,
    "成员已被移除",
  );
  expectFailure(
    await env.service.remove({ group: "team", name: "manager" }, MANAGER),
  );
});

test("投递失败：指令结算为失败并带回原因（状态仍一致）", async () => {
  const env = await ready();
  env.transport.delegateFailure = failure(
    "target_offline",
    "目标不在线：sess-alice",
    "用 session_channel peers 确认目标在线后重试",
  );
  const failed = expectFailure(
    await env.service.send(
      { group: "team", to: "alice", text: "任务" },
      MANAGER,
    ),
  );
  assert.equal(failed.error, "target_offline");
  assert.equal(failed["action"], "send");
  const status = await env.service.status({ group: "team" }, MANAGER);
  const view = status["view"] as GroupView;
  assert.equal(view.summary.failure, 1);
  assert.match(String(view.instructions[0]?.cause), /目标不在线/);
  // 结算后同一连接可再发
  env.transport.delegateFailure = undefined;
  const again = await env.service.send(
    { group: "team", to: "alice", text: "再来" },
    MANAGER,
  );
  assert.equal(again.ok, true, JSON.stringify(again));
});

test("传输端口抛异常：统一转成 transport_error（不把异常抛给工具层）", async () => {
  const env = await ready();
  const throwing: GroupTransport = {
    async resolve() {
      throw new Error("socket 半开");
    },
    async delegate() {
      throw new Error("EPIPE");
    },
    async sendMessage() {
      throw new Error("EPIPE");
    },
    async taskStatus() {
      throw new Error("超时");
    },
  };
  const service = new GroupService({
    store: env.store,
    transport: throwing,
    config: resolveConfig({ defaultTimeoutMs: 60_000 }),
    now: () => 1_000_000,
    newId: () => "id-x",
    log: () => {},
  });
  const resolved = expectFailure(
    await service.addMember(
      { group: "team", name: "carol", target: "sess-carol" },
      MANAGER,
    ),
  );
  assert.equal(resolved.error, "transport_error");
  assert.match(resolved.reason, /socket 半开/);

  const sent = expectFailure(
    await service.send({ group: "team", to: "alice", text: "任务" }, MANAGER),
  );
  assert.equal(sent.error, "transport_error");
  assert.match(sent.reason, /EPIPE/);
  // 投递失败已被结算为失败（连接可重发）
  const status = await service.status({ group: "team" }, MANAGER);
  const view = status["view"] as GroupView;
  assert.equal(view.summary.failure, 1);
});

test("存储不可用：写动作报 state_unavailable；status 命中缓存仍可读", async () => {
  const env = await ready();
  env.store.failSave = new Error("EACCES: 会话目录不可写");
  const failed = expectFailure(
    await env.service.createGroup({ name: "other" }, MANAGER),
  );
  assert.equal(failed.error, "state_unavailable");
  assert.match(failed.reason, /EACCES/);
  assert.match(failed.next, /sessionDirFor/);

  // 缓存未推进：上一次成功写入的状态仍可读
  env.store.failLoad = new Error("目录不存在");
  const status = await env.service.status({ group: "team" }, MANAGER);
  assert.equal(status.ok, true, "只读视图命中缓存，不碰存储");
  assert.equal((status["view"] as GroupView).name, "team");

  // 新会话（无缓存）读不到 → 明示例外
  const otherManager = await env.service.status({ group: "team" }, "sess-x");
  assert.equal(otherManager.ok, false);
  assert.equal((otherManager as GroupFailure).error, "state_unavailable");
});

test("镜像：每次变更写一次；失败只计数不重试，动作仍成功", async () => {
  const env = await ready();
  const before = env.mirror.puts.length;
  await env.service.send({ group: "team", to: "alice", text: "任务" }, MANAGER);
  assert.equal(env.mirror.puts.length, before + 1);
  assert.equal(env.mirror.puts.at(-1)?.summary.open, 1);

  env.mirror.fail = true;
  const sent = await env.service.send(
    { group: "team", to: "bob", text: "给 bob" },
    MANAGER,
  );
  // bob 没有主方 → 拒绝（不触发镜像）；先建连接再试
  assert.equal(sent.ok, false);
  const linked = await env.service.link(
    { group: "team", from: "manager", to: "bob" },
    MANAGER,
  );
  assert.equal(linked.ok, true, "镜像失败不影响动作");
  const status = await env.service.status({ group: "team" }, MANAGER);
  const mirror = status["mirror"] as {
    enabled: boolean;
    ok: number;
    failed: number;
    lastError?: string;
  };
  assert.equal(mirror.enabled, true);
  assert.ok(mirror.failed >= 1);
  assert.match(String(mirror.lastError), /memory-base 拒收/);
});

test("拒绝路径统一带原因 + 下一步；未知 action 与缺组名都有提示", async () => {
  const env = await ready();
  const unknown = expectFailure(await env.service.run("nope", {}, MANAGER));
  assert.equal(unknown.error, "unknown_action");
  assert.match(unknown.next, /create_group/);

  // 本会话已有组：提示指向现有组名（而不是盲目建议新建）
  const noGroup = expectFailure(
    await env.service.status({ group: "ghost" }, MANAGER),
  );
  assert.equal(noGroup.error, "group_not_found");
  assert.match(noGroup.next, /team/);

  // 本会话还没有任何组：提示才指向 create_group
  const empty = expectFailure(
    await env.service.status({ group: "ghost" }, "sess-fresh"),
  );
  assert.equal(empty.error, "group_not_found");
  assert.match(empty.next, /create_group/);

  const noMember = expectFailure(
    await env.service.link(
      { group: "team", from: "manager", to: "ghost" },
      MANAGER,
    ),
  );
  assert.equal(noMember.error, "member_not_found");
  assert.match(noMember.next, /alice/, "下一步应列出可用成员");
});

test("verdictOf：纯函数口径（回报已到 / 超时 / 仍算未结 / 传输错误）", () => {
  const instruction: GroupInstruction = {
    id: "i-1",
    from: "manager",
    to: "alice",
    text: "任务",
    fromSessionId: MANAGER,
    taskId: "task-1",
    timeoutMs: 1000,
    sentAt: 0,
    deadline: 1000,
    status: "open",
  };
  assert.deepEqual(
    verdictOf(
      instruction,
      { ok: true, task: { status: "done", result: "x" } },
      0,
    ),
    { open: false, status: "success", result: "x" },
  );
  assert.deepEqual(
    verdictOf(instruction, { ok: true, task: { status: "running" } }, 999),
    { open: true },
  );
  assert.deepEqual(
    verdictOf(instruction, { ok: true, task: { status: "running" } }, 1000),
    {
      open: false,
      status: "timeout",
      cause: "超出等待上限（1000 ms，本地判定）",
    },
  );
  assert.deepEqual(
    verdictOf(instruction, failure("transport_error", "连接断了", "重试"), 0),
    { open: false, status: "failure", cause: "连接断了" },
  );
  assert.deepEqual(
    verdictOf(instruction, failure("task_not_found", "没了", "重发"), 0),
    {
      open: false,
      status: "failure",
      cause: "任务记录不存在（可能已过期）",
    },
  );
});

test("link_peer：建立平等连接、每对至多一条、不产生未结指令", async () => {
  const env = await ready();
  const linked = await env.service.linkPeer(
    { group: "team", from: "manager", to: "bob" },
    MANAGER,
  );
  assert.equal(linked.ok, true, JSON.stringify(linked));
  const link = linked["link"] as { from: string; to: string };
  assert.deepEqual([link.from, link.to].sort(), ["bob", "manager"]);
  const view = linked["view"] as GroupView;
  assert.equal(view.summary.peerLinks, 1);
  // 每对至多一条：反向再建被拒
  const dup = await env.service.linkPeer(
    { group: "team", from: "bob", to: "manager" },
    MANAGER,
  );
  const dupFail = expectFailure(dup);
  assert.equal(dupFail.error, "peer_link_exists");
  const status = await env.service.status({ group: "team" }, MANAGER);
  const sut = status["view"] as GroupView;
  assert.equal(sut.summary.open, 0, "平等连接不产生未结指令");
});

test("send_peer：经平等连接发消息（发完即走、回执 delivered）、无平连接被拒", async () => {
  const env = await ready();
  // 未建平等连接 → 拒绝
  const noLink = await env.service.sendPeer(
    { group: "team", to: "bob", text: "嗨" },
    MANAGER,
  );
  assert.equal(noLink.ok, false);
  assert.equal(noLink["error"], "no_peer_link");

  await env.service.linkPeer(
    { group: "team", from: "manager", to: "bob" },
    MANAGER,
  );
  const sent = await env.service.sendPeer(
    { group: "team", to: "bob", text: "嗨" },
    MANAGER,
  );
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent["delivered"], true);
  assert.deepEqual(env.transport.sent, [{ to: "sess-bob", text: "嗨" }]);
  // 不落未结、不进 instructions
  const status = await env.service.status({ group: "team" }, MANAGER);
  const view = status["view"] as GroupView;
  assert.equal(view.summary.open, 0);
  assert.equal(view.instructions.length, 0);

  // 投递失败 → 逐条失败可区分
  env.transport.sendFailure = failure("target_offline", "目标不在线", "重试");
  const failed = await env.service.sendPeer(
    { group: "team", to: "bob", text: "再嗨" },
    MANAGER,
  );
  assert.equal(failed.ok, false);
  assert.equal(failed["error"], "target_offline");
});

test("broadcast：按成员集合逐条发送、送达与失败可区分、不产生未结", async () => {
  const env = await ready();
  const cast = await env.service.broadcast(
    { group: "team", text: "全体注意" },
    MANAGER,
  );
  assert.equal(cast.ok, true, JSON.stringify(cast));
  assert.deepEqual(cast["targets"], ["alice", "bob"]);
  const results = cast["results"] as Array<Record<string, unknown>>;
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r["delivered"] === true));
  assert.deepEqual(
    cast["delivery"] as { targets: number; delivered: number; failed: number },
    { targets: 2, delivered: 2, failed: 0 },
  );
  assert.deepEqual(env.transport.sent.map((s) => s.to).sort(), [
    "sess-alice",
    "sess-bob",
  ]);
  const status = await env.service.status({ group: "team" }, MANAGER);
  assert.equal((status["view"] as GroupView).summary.open, 0);

  // 其中一个投递失败 → 汇总里 failed=1、逐条可区分
  env.transport.sendDelivered = true;
  env.transport.sendFailure = failure("target_offline", "目标不在线", "重试");
  const partial = await env.service.broadcast(
    { group: "team", to: "alice,bob", text: "再全体" },
    MANAGER,
  );
  assert.equal(partial.ok, true, JSON.stringify(partial));
  const partialResults = partial["results"] as Array<Record<string, unknown>>;
  assert.equal(partialResults.length, 2);
  const failRows = partialResults.filter((r) => r["delivered"] === false);
  assert.equal(
    failRows.length,
    2,
    "send 失败 → 每条标记 delivered:false 且带 error",
  );
  assert.ok(failRows.every((r) => r["error"] === "target_offline"));
  assert.deepEqual(partial["delivery"], {
    targets: 2,
    delivered: 0,
    failed: 2,
  });
});

test("broadcast：显式 to 子集校验成员存在；空正文被拒", async () => {
  const env = await ready();
  const bad = await env.service.broadcast(
    { group: "team", to: "ghost", text: "x" },
    MANAGER,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad["error"], "member_not_found");
  const empty = await env.service.broadcast(
    { group: "team", text: "   " },
    MANAGER,
  );
  assert.equal(empty.ok, false);
  assert.equal(empty["error"], "invalid_argument");
});

test("readGroupStatus：按会话 id 读只读组清单（全组 / 指定组 / 缺组 / 读失败）", async () => {
  const env = await ready();
  await env.service.linkPeer(
    { group: "team", from: "manager", to: "alice" },
    MANAGER,
  );
  const all = await readGroupStatus(env.store, MANAGER);
  assert.ok(!isFailure(all), JSON.stringify(all));
  assert.equal(all.groups.length, 1);
  assert.equal(all.groups[0]?.name, "team");
  assert.equal(all.groups[0]?.view.summary.peerLinks, 1);

  const one = await readGroupStatus(env.store, MANAGER, "team");
  assert.ok(!isFailure(one));
  assert.equal(one.groups.length, 1);

  const missing = await readGroupStatus(env.store, MANAGER, "nope");
  assert.ok(isFailure(missing));
  assert.equal(missing.error, "group_not_found");

  // 读失败（load 抛错）→ state_unavailable
  env.store.failLoad = new Error("库打不开（测试注入）");
  const failed = await readGroupStatus(env.store, MANAGER);
  assert.ok(isFailure(failed));
  assert.equal(failed.error, "state_unavailable");
});
