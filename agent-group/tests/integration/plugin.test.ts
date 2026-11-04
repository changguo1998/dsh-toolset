/**
 * 集成层：本包 `apply` 与宿主接线的验收 —— 工具注册名与 `execute` 的 canonical 值、
 * `output.render` 的投影文本、只读服务面 `agentGroup` 的 provide / 读取，以及服务缺失时的
 * 调用期错误。装配见同目录上一级的 `agent-group/tests/assemble.ts`（三个假面：工具 / 事件 / 服务）。
 *
 * 落盘写 `mkdtemp` 的临时目录，不连 Redis、不起真宿主。
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ToolDef } from "../../src/index.ts";
import { inject, name, provide } from "../../src/index.ts";
import { assemble, MANAGER, readService } from "../assemble.ts";
import type { AssemblyOptions } from "../assemble.ts";
import type { GroupFailure } from "../../src/types.ts";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-group-integration-"));
  dirs.push(dir);
  return dir;
}

/** 起一套装配好的环境（默认全服务、镜像打开）。 */
async function environment(
  options: Omit<Partial<AssemblyOptions>, "root"> = {},
) {
  const root = await tempDir();
  const assembly = assemble({ root, ...options });
  assembly.channel.online.add(MANAGER);
  assembly.channel.online.add("sess-alice");
  assembly.channel.online.add("sess-bob");
  assembly.channel.aliases.set("alice-alias", "sess-alice");
  return { root, assembly };
}

function expectFailure(value: Record<string, unknown>): GroupFailure {
  const failed = value as unknown as GroupFailure;
  assert.equal(failed.ok, false, `应为拒绝：${JSON.stringify(failed)}`);
  assert.notEqual(failed.reason, "");
  assert.notEqual(failed.next, "");
  return failed;
}

/** 宿主同口径的 lossless JSON 判定（`undefined` / 非有限数 / 非平凡原型一律非法）。 */
function isLosslessJson(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return value.every(isLosslessJson);
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isLosslessJson);
}

test("注册面: apply 注册唯一工具 agent_group 与只读服务面 agentGroup", async () => {
  const { assembly } = await environment();
  assert.equal(name, "agent-group");
  assert.deepEqual(inject, ["tools"], "注册面是必需依赖");
  assert.deepEqual(provide, ["agentGroup"]);
  assert.deepEqual(assembly.tools, ["agent_group"]);
  assert.deepEqual([...assembly.provided.keys()], ["agentGroup"]);
  assert.deepEqual(assembly.logs, []);
});

test("注册面: 宿主没有 tools 面时只警告一次，不注册也不提供", async () => {
  const { assembly } = await environment({ tools: false });
  assert.deepEqual(assembly.tools, []);
  assert.deepEqual([...assembly.provided.keys()], []);
  assert.equal(assembly.logs.length, 1);
  assert.match(assembly.logs[0] ?? "", /tools 未挂载/);
});

test("注册面: 宿主没有 provide 面时 apply 不抛，工具照常注册", async () => {
  const { assembly } = await environment({ provide: false });
  assert.deepEqual(assembly.tools, ["agent_group"]);
  assert.deepEqual([...assembly.provided.keys()], []);
});

test("事件面: 本包不订阅任何宿主事件（能力全在工具与服务面）", async () => {
  const { assembly } = await environment();
  const events = assembly.ctx["events"] as {
    subscriptions: Array<{ event: string }>;
  };
  assert.deepEqual(events.subscriptions, []);
});

test("工具注册面: 名称 / 动作枚举 / 必填参数 / 描述与实际动作一致", async () => {
  const { assembly } = await environment();
  assert.equal(assembly.tool().name, "agent_group");
  const parameters = assembly.tool().parameters as {
    properties: { action: { enum: string[] } };
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(parameters.properties.action.enum, [
    "create_group",
    "add_member",
    "link",
    "link_peer",
    "send",
    "send_peer",
    "broadcast",
    "check",
    "remove",
    "close_group",
    "status",
  ]);
  assert.deepEqual(parameters.required, ["action"]);
  assert.equal(parameters.additionalProperties, false);
  assert.match(assembly.tool().description, /colleague|同事|群组/);
});

test("工具 execute: 建组 → 加成员 → 连接 → 发指令 → 结算 → 状态，返回体是 canonical 值", async () => {
  const { root, assembly } = await environment();
  const results: Array<Record<string, unknown>> = [];

  const created = await assembly.call({ action: "create_group", name: "team" });
  results.push(created);
  assert.equal(created["ok"], true, JSON.stringify(created));
  assert.equal(created["action"], "create_group");
  assert.equal(created["group"], "team");
  const createdView = created["view"] as {
    members: Array<{ name: string }>;
    summary: { members: number };
  };
  assert.deepEqual(
    createdView.members.map((member) => member.name),
    ["manager"],
  );
  assert.equal(createdView.summary.members, 1);

  const added = await assembly.call({
    action: "add_member",
    group: "team",
    name: "alice",
    target: "alice-alias",
  });
  results.push(added);
  assert.equal(added["ok"], true, JSON.stringify(added));
  assert.equal(added["action"], "add_member");
  assert.equal(added["member"], "alice");
  assert.equal(added["sessionId"], "sess-alice", "别名经传输解析成会话 id");

  const linked = await assembly.call({
    action: "link",
    group: "team",
    from: "manager",
    to: "alice",
  });
  results.push(linked);
  assert.equal(linked["ok"], true, JSON.stringify(linked));
  assert.equal(linked["level"], 1, "从方等级 = 主方 + 1");

  const sent = await assembly.call({
    action: "send",
    group: "team",
    to: "alice",
    text: "写一份设计",
    timeoutMs: 60_000,
  });
  results.push(sent);
  assert.equal(sent["ok"], true, JSON.stringify(sent));
  assert.equal(sent["taskId"], "task-1");
  assert.equal(sent["from"], "manager");
  assert.equal(sent["deadline"], Number(sent["sentAt"]) + 60_000);
  assert.deepEqual(assembly.channel.delegated, [
    {
      from: MANAGER,
      to: "sess-alice",
      text: "写一份设计",
      timeoutSec: 60,
    },
  ]);

  const stillOpen = await assembly.call({ action: "check", group: "team" });
  results.push(stillOpen);
  assert.deepEqual(stillOpen["open"], ["alice"]);
  assert.deepEqual(stillOpen["settled"], []);

  assembly.channel.tasks.set("task-1", { status: "done", result: "设计在这" });
  const checked = await assembly.call({ action: "check", group: "team" });
  results.push(checked);
  const settled = checked["settled"] as Array<Record<string, unknown>>;
  assert.equal(settled[0]?.["status"], "success");
  assert.equal(settled[0]?.["result"], "设计在这");
  assert.deepEqual(checked["idle"], []);

  const status = await assembly.call({ action: "status", group: "team" });
  results.push(status);
  assert.equal(status["ok"], true);
  const view = status["view"] as {
    members: Array<{ name: string; principal: string | null }>;
    summary: { success: number; open: number };
  };
  assert.equal(view.summary.success, 1);
  assert.equal(view.summary.open, 0);
  assert.equal(
    view.members.find((member) => member.name === "alice")?.principal,
    "manager",
  );
  assert.deepEqual(status["mirror"], { enabled: true, ok: 6, failed: 0 });

  for (const result of results) {
    assert.ok(isLosslessJson(result), JSON.stringify(result));
  }

  // 状态落在管理者会话目录（sessionPaths.sessionDirFor 推导）
  const file = join(root, `session-${MANAGER}`, "agent-group.json");
  const saved = JSON.parse(await readFile(file, "utf8")) as {
    version: number;
    groups: Record<string, { instructions: Array<{ status: string }> }>;
  };
  assert.equal(saved.version, 1);
  assert.equal(saved.groups["team"]?.instructions[0]?.status, "success");
});

test("工具 execute: 缺调用方会话 → no_caller；缺服务 → 调用期错误带 action", async () => {
  const { assembly } = await environment();
  const noCaller = await assembly
    .tool()
    .execute({ action: "status" }, undefined);
  const missing = expectFailure(noCaller);
  assert.equal(missing.error, "no_caller");

  const noChannel = assemble({
    root: await tempDir(),
    with: { channel: false },
  });
  const channelless = expectFailure(
    await noChannel.call({ action: "status", group: "team" }),
  );
  assert.equal(channelless.error, "session_channel_unavailable");
  assert.equal(channelless["action"], "status");

  const noPaths = assemble({ root: await tempDir(), with: { paths: false } });
  const pathless = expectFailure(
    await noPaths.call({ action: "status", group: "team" }),
  );
  assert.equal(pathless.error, "session_paths_unavailable");
  assert.equal(pathless["action"], "status");
});

test("工具 execute: 服务解析成功一次即复用（文件被删后 status 仍从缓存读）", async () => {
  const { root, assembly } = await environment();
  await assembly.call({ action: "create_group", name: "team" });
  const file = join(root, `session-${MANAGER}`, "agent-group.json");
  await unlink(file);

  const status = await assembly.call({ action: "status", group: "team" });
  assert.equal(status["ok"], true, "缓存命中时不再读盘");
  assert.equal((status["view"] as { name: string }).name, "team");
});

test("工具 output.render: 投影为缩进 JSON 文本，字符串原样，不可序列化值回落 String", async () => {
  const { assembly } = await environment();
  const tool: ToolDef = assembly.tool();

  const objectRender = tool.output.render({}, { ok: true, group: "team" });
  assert.equal(objectRender.length, 1);
  assert.equal(objectRender[0]?.type, "text");
  assert.equal(
    objectRender[0]?.text,
    JSON.stringify({ ok: true, group: "team" }, null, 2),
  );

  const stringRender = tool.output.render({}, "已经是一段文本");
  assert.equal(stringRender[0]?.text, "已经是一段文本");

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const cyclicRender = tool.output.render({}, cyclic);
  assert.equal(cyclicRender[0]?.text, String(cyclic));
});

test("只读服务面: status 读落盘组清单 / 指定组 / 不存在的组", async () => {
  const { assembly } = await environment();
  await assembly.call({ action: "create_group", name: "team" });
  await assembly.call({ action: "create_group", name: "review" });
  const service = readService(assembly);

  const all = await service.status(MANAGER);
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.deepEqual(all.ok ? all.groups.map((group) => group.name) : [], [
    "review",
    "team",
  ]);
  assert.equal(all.ok ? all.groups[0]?.view.summary.members : 0, 1);

  const only = await service.status(MANAGER, "team");
  assert.equal(only.ok, true);
  assert.equal(only.ok ? only.groups.length : 0, 1);
  assert.equal(only.ok ? only.groups[0]?.name : undefined, "team");

  const missing = await service.status(MANAGER, "nope");
  assert.equal(missing.ok, false);
  assert.equal((missing as GroupFailure).error, "group_not_found");
  assert.match((missing as GroupFailure).next, /review/);
});

test("只读服务面: 缺 sessionPaths → session_paths_unavailable；状态文件损坏 → state_unavailable", async () => {
  const pathless = assemble({
    root: await tempDir(),
    with: { paths: false },
  });
  const missingPaths = await readService(pathless).status(MANAGER);
  assert.equal(missingPaths.ok, false);
  assert.equal(
    (missingPaths as GroupFailure).error,
    "session_paths_unavailable",
  );

  const { root, assembly } = await environment();
  const dir = join(root, `session-${MANAGER}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "agent-group.json"), "{ 不是 JSON", "utf8");

  const broken = await readService(assembly).status(MANAGER);
  assert.equal(broken.ok, false);
  assert.equal((broken as GroupFailure).error, "state_unavailable");
  assert.match((broken as GroupFailure).reason, /不是合法 JSON/);
});

test("只读服务面: 附成员状态（离线 / 工作 / 疑似卡死），只读不写盘不镜像", async () => {
  const { assembly } = await environment({
    config: { stuckAfterMs: 60_000, statusPollMs: 0 },
  });
  await assembly.call({ action: "create_group", name: "team" });
  await assembly.call({
    action: "add_member",
    group: "team",
    name: "alice",
    target: "alice-alias",
  });
  await assembly.call({
    action: "add_member",
    group: "team",
    name: "bob",
    target: "sess-bob",
  });
  const writesBefore = assembly.memory.writes.length;

  const now = Date.now();
  assembly.channel.online.delete("sess-bob");
  assembly.channel.agentStates.set("sess-alice", {
    status: "running",
    at: now,
  });
  const working = await readService(assembly).status(MANAGER, "team");
  assert.equal(working.ok, true);
  const states = working.ok ? (working.groups[0]?.memberStates ?? []) : [];
  const byName = new Map(states.map((state) => [state.name, state]));
  assert.equal(byName.get("alice")?.state, "working");
  assert.equal(byName.get("alice")?.rawStatus, "running");
  assert.equal(byName.get("bob")?.state, "offline");
  assert.equal(byName.get("manager")?.state, "idle", "在线无牌按待机");

  // 疑似卡死：状态牌时间早于阈值
  assembly.channel.online.add("sess-bob");
  assembly.channel.agentStates.set("sess-alice", {
    status: "running",
    at: now - 120_000,
  });
  const stuck = await readService(assembly).status(MANAGER, "team");
  const stuckStates = stuck.ok ? (stuck.groups[0]?.memberStates ?? []) : [];
  assert.equal(
    stuckStates.find((state) => state.name === "alice")?.state,
    "stuck",
  );

  assert.equal(
    assembly.memory.writes.length,
    writesBefore,
    "只读服务面不镜像、不落盘",
  );
});

test("只读服务面: session-channel 未挂时写动作被拒，已有组仍可只读（成员状态缺省）", async () => {
  const { root, assembly } = await environment();
  await assembly.call({ action: "create_group", name: "team" });

  // 第二个进程只挂 session-paths：读服务面照常读盘，成员状态缺省
  const withoutChannel = assemble({ root, with: { channel: false } });
  const read = await readService(withoutChannel).status(MANAGER, "team");
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.ok ? read.groups[0]?.name : undefined, "team");
  assert.deepEqual([...withoutChannel.provided.keys()], ["agentGroup"]);
  const write = expectFailure(
    await withoutChannel.call({
      action: "add_member",
      group: "team",
      name: "x",
    }),
  );
  assert.equal(write.error, "session_channel_unavailable");
});
