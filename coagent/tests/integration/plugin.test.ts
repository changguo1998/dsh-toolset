/**
 * 集成层：本包 `apply` 与宿主接线的验收 —— 工具注册名与参数面、`execute` 的 canonical 回执、
 * `output.render` 的投影文本、服务面缺席 / 降级时的告警与失败码，以及落盘位置。
 *
 * 装配见上一级 `tests/assemble.ts`（三个假面：工具 / 事件 / 服务）；全程不连 Redis、不起
 * 真宿主，落盘写 `mkdtemp` 的临时目录。时钟用真实时间，故 config 把认领与优雅退出的等待
 * 压到毫秒级。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { inject, name } from "../../src/index.ts";
import { assemble, PARENT } from "../assemble.ts";

const dirs: string[] = [];
const envBefore = process.env["DSH_HOME"];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  if (envBefore === undefined) delete process.env["DSH_HOME"];
  else process.env["DSH_HOME"] = envBefore;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "coagent-integration-"));
  dirs.push(dir);
  return dir;
}

/** 让 `peers` 里立刻有一条匹配的新会话（真实时钟下无需等轮询）。 */
function peerOnline(
  assembly: ReturnType<typeof assemble>,
  options: { cwd: string; sessionId?: string },
): void {
  assembly.channel.addPeer({
    sessionId: options.sessionId ?? "sess-child",
    pid: 4321,
    cwd: options.cwd,
    startedAt: Date.now(),
  });
}

test("注册面: apply 注册唯一工具 coagent，参数面收窄且不订阅事件 / 不 provide 服务", async () => {
  const root = await tempDir();
  const assembly = assemble({ root });

  assert.equal(name, "coagent");
  assert.deepEqual(inject, ["tools", "herdrUse", "sessionChannel"]);
  assert.deepEqual(assembly.tools, ["coagent"]);
  assert.deepEqual(assembly.subscriptions, []);
  assert.deepEqual([...assembly.provided.keys()], []);
  assert.deepEqual(assembly.logs, [], "全服务在场时不该有告警");

  const parameters = assembly.tool().parameters as {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, { type?: string; enum?: string[] }>;
  };
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.required, ["action"]);
  assert.deepEqual(parameters.properties["action"]?.enum, [
    "spawn",
    "list",
    "close",
  ]);
  assert.deepEqual(parameters.properties["state"]?.enum, [
    "starting",
    "ready",
    "closing",
    "closed",
    "failed",
    "lost",
  ]);
  assert.deepEqual(parameters.properties["probe"]?.enum, ["live", "none"]);
  for (const removed of ["target", "task", "text", "pane_id", "tab_id"]) {
    assert.equal(
      parameters.properties[removed],
      undefined,
      `参数面不该再有 ${removed}`,
    );
  }
});

test("注册面: 缺 herdrUse 不注册并告警一次（F1）", async () => {
  const root = await tempDir();
  const assembly = assemble({ root, with: { herdr: false } });

  assert.deepEqual(assembly.tools, []);
  assert.equal(assembly.logs.length, 1);
  assert.match(assembly.logs[0] ?? "", /herdrUse/);
});

test("注册面: 缺 sessionChannel 不注册并告警一次（F1）", async () => {
  const root = await tempDir();
  const assembly = assemble({ root, with: { channel: false } });

  assert.deepEqual(assembly.tools, []);
  assert.equal(assembly.logs.length, 1);
  assert.match(assembly.logs[0] ?? "", /sessionChannel/);
});

test("注册面: herdrUse 形状残缺（缺 close）按缺失处理，不降级到库面", async () => {
  const root = await tempDir();
  const assembly = assemble({ root, herdrShape: "incomplete" });

  assert.deepEqual(assembly.tools, []);
  assert.match(assembly.logs.join("\n"), /herdrUse/);
});

test("注册面: 宿主没有 tools 面时不注册工具，也不抛", async () => {
  const root = await tempDir();
  const assembly = assemble({ root, tools: false });

  assert.deepEqual(assembly.tools, []);
  assert.deepEqual(assembly.logs, []);
});

test("注册面: enabled=false 不注册也不告警", async () => {
  const root = await tempDir();
  const assembly = assemble({ root, config: { enabled: false } });

  assert.deepEqual(assembly.tools, []);
  assert.deepEqual(assembly.logs, []);
});

test("注册面: ctx.get 抛错时退化到属性读取，工具照常注册", async () => {
  const root = await tempDir();
  const assembly = assemble({ root, get: "throws" });

  assert.deepEqual(assembly.tools, ["coagent"]);
  assert.deepEqual(assembly.logs, []);
});

test("注册面: logger 缺 warn 时退到 info，logger 抛错不阻断注册", async () => {
  const root = await tempDir();
  const infoOnly = assemble({
    root,
    with: { paths: false },
    logger: "info-only",
  });
  assert.deepEqual(infoOnly.tools, ["coagent"]);
  assert.match(infoOnly.logs.join("\n"), /sessionPaths/);

  const broken = assemble({ root, with: { paths: false }, logger: "throws" });
  assert.deepEqual(broken.tools, ["coagent"]);
  assert.deepEqual(broken.logs, []);
});

test("工具: spawn 的 canonical 回执与只走服务面的三次调用", async () => {
  const root = await tempDir();
  const assembly = assemble({ root });
  peerOnline(assembly, { cwd: root });

  const reply = await assembly.call({ action: "spawn", label: "reviewer" });

  assert.equal(reply["ok"], true);
  assert.equal(reply["state"], "ready");
  assert.equal(reply["cmd"], "fffdsh");
  assert.equal(reply["cwd"], root);
  assert.equal(reply["label"], "reviewer");
  assert.equal(reply["session_id"], "sess-child");
  const coagentId = String(reply["coagent_id"]);
  assert.match(coagentId, /^c-[0-9a-f]{8}$/);
  assert.equal(reply["terminal_label"], `coagent/${coagentId}`);
  assert.equal(reply["terminal_id"], "t1");
  assert.equal(typeof reply["started_at"], "number");
  assert.ok(
    Number(reply["claimed_at"]) >= Number(reply["started_at"]),
    "claimed_at 不早于 started_at",
  );
  assert.deepEqual(reply["paths"], {
    dir: join(root, `session-${PARENT}`, "coagent", coagentId),
  });
  for (const removed of ["pane_id", "tab_id", "task", "text"]) {
    assert.equal(reply[removed], undefined, `回执不该再有 ${removed}`);
  }

  // 服务面：create 一次（前台 + 固定 label）、run 一次（fffdsh）、read 两次以内。
  assert.equal(assembly.herdr.countOf("create"), 1);
  assert.deepEqual(assembly.herdr.lastCall("create")?.args[0], {
    foreground: true,
    cwd: root,
    label: `coagent/${coagentId}`,
  });
  assert.equal(assembly.herdr.countOf("run"), 1);
  assert.equal(assembly.herdr.lastCall("run")?.args[1], "fffdsh");
  assert.equal(assembly.herdr.countOf("close"), 0);

  // 落盘：索引 + meta + claim.log。
  const index = JSON.parse(
    await readFile(
      join(assembly.sessionDir(), "coagent", "index.json"),
      "utf8",
    ),
  ) as { records: Record<string, Record<string, unknown>> };
  assert.equal(index.records[coagentId]?.["state"], "ready");
  const dir = assembly.recordDir(coagentId);
  const meta = JSON.parse(
    await readFile(join(dir, "meta.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(meta["session_id"], "sess-child");
  assert.match(
    await readFile(join(dir, "claim.log"), "utf8"),
    /认领到会话 sess-child/,
  );
});

test("工具: output.render 投影为 JSON 文本，字符串原样，循环引用走兜底", async () => {
  const root = await tempDir();
  const assembly = assemble({ root });
  const render = assembly.tool().output.render;

  const projected = render({}, { ok: true, items: [] });
  assert.deepEqual(projected, [
    { type: "text", text: JSON.stringify({ ok: true, items: [] }, null, 2) },
  ]);
  assert.deepEqual(render({}, "已经是字符串"), [
    { type: "text", text: "已经是字符串" },
  ]);

  const circular: Record<string, unknown> = { ok: false };
  circular["self"] = circular;
  const fallback = render({}, circular);
  assert.equal(fallback[0]?.type, "text");
  assert.equal(fallback[0]?.text, "[object Object]");
});

test("工具: list 的 canonical 回执（空列表 / 状态过滤 / 参数校验）", async () => {
  const root = await tempDir();
  const assembly = assemble({ root });

  const empty = await assembly.call({ action: "list" });
  assert.deepEqual(empty, { ok: true, items: [], live: 0, max_live: 4 });

  peerOnline(assembly, { cwd: root });
  const spawned = await assembly.call({ action: "spawn" });
  assert.equal(spawned["ok"], true);

  const listed = await assembly.call({ action: "list", probe: "none" });
  assert.equal(listed["live"], 1);
  const items = listed["items"] as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.["coagent_id"], spawned["coagent_id"]);
  assert.equal(items[0]?.["state"], "ready");
  assert.equal(items[0]?.["terminal_id"], spawned["terminal_id"]);
  assert.equal(items[0]?.["session_id"], "sess-child");
  assert.equal(items[0]?.["label"], spawned["label"]);
  assert.equal(typeof items[0]?.["elapsed_ms"], "number");
  assert.equal(items[0]?.["terminal_running"], undefined, "probe=none 不探测");

  const filtered = await assembly.call({ action: "list", state: "lost" });
  assert.deepEqual(filtered["items"], []);

  const badState = await assembly.call({ action: "list", state: "running" });
  assert.equal(badState["error"], "invalid_params");
  assert.match(String(badState["reason"]), /state 只支持/);

  const extra = await assembly.call({ action: "list", force: true });
  assert.equal(extra["error"], "invalid_params");
  assert.match(String(extra["next"]), /coagent_id \/ state \/ probe \/ limit/);
});

test("工具: close 的 canonical 回执（优雅退出 / 幂等归档）", async () => {
  const root = await tempDir();
  const assembly = assemble({ root, config: { gracePollMs: 1 } });
  peerOnline(assembly, { cwd: root });
  const spawned = await assembly.call({ action: "spawn" });
  const coagentId = String(spawned["coagent_id"]);

  const closed = await assembly.call({
    action: "close",
    coagent_id: coagentId,
  });
  assert.equal(closed["ok"], true);
  assert.equal(closed["state"], "closed");
  assert.equal(closed["coagent_id"], coagentId);
  assert.equal(closed["terminal_id"], spawned["terminal_id"]);
  assert.equal(closed["closed_with"], "quit");
  assert.equal(closed["removed_files"], true);
  assert.equal(
    closed["archived_from"],
    undefined,
    "ready 归档不带 archived_from",
  );

  // 服务面：先 /quit 再 close，各一次。
  const commands = assembly.herdr.calls
    .filter((call) => call.method === "run")
    .map((call) => call.args[1]);
  assert.deepEqual(commands, ["fffdsh", "/quit"]);
  assert.equal(assembly.herdr.countOf("close"), 1);

  const again = await assembly.call({ action: "close", coagent_id: coagentId });
  assert.equal(again["ok"], true);
  assert.equal(again["already_closed"], true);
  assert.equal(again["removed_files"], false);
  assert.equal(assembly.herdr.countOf("close"), 1);
});

test("失败路径: 无调用方会话与未知动作的 canonical 错误码", async () => {
  const root = await tempDir();
  const assembly = assemble({ root });

  const noCaller = await assembly.tool().execute({ action: "list" }, undefined);
  assert.equal(noCaller["ok"], false);
  assert.equal(noCaller["error"], "session_unavailable");
  assert.match(String(noCaller["next"]), /父会话/);

  const unknown = await assembly.call({ action: "send", task: "x" });
  assert.equal(unknown["ok"], false);
  assert.equal(unknown["error"], "invalid_action");
  assert.match(String(unknown["next"]), /channel_delegate/);

  const noExec = await assembly.tool().execute({ action: "list" }, {});
  assert.equal(noExec["error"], "session_unavailable");
});

test("失败路径: sessionDirFor 抛错 → session_paths_unavailable", async () => {
  const root = await tempDir();
  const assembly = assemble({ root, with: { paths: true } });
  assembly.paths.state.fail = true;

  const reply = await assembly.call({ action: "list" });

  assert.equal(reply["ok"], false);
  assert.equal(reply["error"], "session_paths_unavailable");
  assert.match(String(reply["reason"]), /会话目录不可用/);
  assert.match(String(reply["next"]), /session-paths/);
});

test("失败路径: 认领超时 → claim_timeout，落 lost 记录且终端保留", async () => {
  const root = await tempDir();
  const assembly = assemble({
    root,
    config: { claimTimeoutSec: 1, pollIntervalMs: 1 },
  });

  const reply = await assembly.call({ action: "spawn" });

  assert.equal(reply["ok"], false);
  assert.equal(reply["error"], "claim_timeout");
  assert.match(String(reply["reason"]), /peers 里没有匹配的新会话/);
  assert.match(String(reply["next"]), /coagent list/);
  assert.equal(assembly.herdr.countOf("close"), 0, "超时不关终端");

  const coagentId = String(reply["coagent_id"]);
  const index = JSON.parse(
    await readFile(
      join(assembly.sessionDir(), "coagent", "index.json"),
      "utf8",
    ),
  ) as { records: Record<string, Record<string, unknown>> };
  assert.equal(index.records[coagentId]?.["state"], "lost");
  assert.equal(index.records[coagentId]?.["fail_code"], "claim_timeout");
  assert.equal(index.records[coagentId]?.["terminal_closed"], undefined);
});

test("落盘降级: 缺 sessionPaths 时写 $DSH_HOME/coagent/<会话 id>/ 并告警一次", async () => {
  const root = await tempDir();
  const dshHome = join(root, "dsh-home");
  process.env["DSH_HOME"] = dshHome;
  const assembly = assemble({ root, with: { paths: false } });
  assembly.channel.addPeer({
    sessionId: "sess-child",
    pid: 4321,
    cwd: root,
    startedAt: Date.now(),
  });

  const reply = await assembly.call({ action: "spawn" });

  assert.equal(reply["ok"], true);
  assert.equal(assembly.logs.length, 1);
  assert.match(assembly.logs[0] ?? "", /sessionPaths/);
  const indexPath = join(dshHome, "coagent", PARENT, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    records: Record<string, Record<string, unknown>>;
  };
  assert.equal(index.records[String(reply["coagent_id"])]?.["state"], "ready");
});

test("失败路径: 索引损坏 → record_write_failed，next 指向写权限与核对", async () => {
  const root = await tempDir();
  const assembly = assemble({ root });
  await mkdir(join(root, `session-${PARENT}`, "coagent"), { recursive: true });
  await writeFile(
    join(root, `session-${PARENT}`, "coagent", "index.json"),
    "{ 不是 JSON",
    "utf8",
  );

  const reply = await assembly.call({ action: "list" });

  assert.equal(reply["ok"], false);
  assert.equal(reply["error"], "record_write_failed");
  assert.match(String(reply["reason"]), /状态落盘失败/);
  assert.match(String(reply["next"]), /可写/);
});

test("失败路径: 探测抛错时保留原状态并告警，不让 list 因一次失败改坏记录", async () => {
  const root = await tempDir();
  const assembly = assemble({ root, config: { gracePollMs: 1 } });
  peerOnline(assembly, { cwd: root });
  const spawned = await assembly.call({ action: "spawn" });
  const terminalId = String(spawned["terminal_id"]);

  // 终端没有前台进程且 peers 抛错：证据不足，保留 ready。
  const terminal = assembly.herdr.terminals.get(terminalId);
  assert.ok(terminal !== undefined);
  terminal.running = false;
  assembly.channel.peers = async () => {
    throw new Error("Redis 连接断开（测试注入）");
  };

  const listed = await assembly.call({ action: "list" });

  assert.equal(listed["ok"], true);
  const items = listed["items"] as Array<Record<string, unknown>>;
  assert.equal(items[0]?.["state"], "ready");
  assert.match(assembly.logs.join("\n"), /探测 c-/);
  assert.match(assembly.logs.join("\n"), /保留原状态/);
});
