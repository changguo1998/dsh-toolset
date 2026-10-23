/**
 * tests/spawn.test.ts — T1 至 T8、T13：拉起链路、只走服务面、前台约束、失败回滚与认领超时。
 *
 * 全部由 fake herdrUse + fake sessionChannel + 假时钟 + 临时目录驱动；断言口径按新契约：
 * 回执只有 `terminal_id`（无 `pane_id` / `tab_id`），回滚只调一次 `close`。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  createHarness,
  readArtifact,
  schedulePeer,
  PARENT,
  PROFILE,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness !== undefined) await harness.cleanup();
  }
});

async function harness(
  options: Parameters<typeof createHarness>[0] = {},
): Promise<Harness> {
  const created = await createHarness(options);
  harnesses.push(created);
  return created;
}

async function indexOf(harness: Harness): Promise<Record<string, unknown>> {
  const text = await readFile(
    join(harness.sessionDir(), "coagent", "index.json"),
    "utf8",
  );
  return JSON.parse(text) as Record<string, unknown>;
}

function recordsOf(
  index: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return index["records"] as Record<string, Record<string, unknown>>;
}

test("T1 spawn 成功：create 一次 + run 一次 fffdsh + 认领 + 落盘", async () => {
  const h = await harness();
  schedulePeer(h);

  const reply = await h.spawn({ cwd: h.parentCwd, label: "reviewer" });

  assert.equal(reply["ok"], true);
  assert.equal(reply["state"], "ready");
  assert.equal(reply["cmd"], "fffdsh");
  assert.equal(reply["session_id"], "sess-child");
  assert.equal(reply["label"], "reviewer");
  assert.match(String(reply["terminal_id"]), /^t\d+$/);
  assert.equal(reply["pane_id"], undefined);
  assert.equal(reply["tab_id"], undefined);

  const coagentId = String(reply["coagent_id"]);
  assert.match(coagentId, /^c-[0-9a-f]{8}$/);
  assert.equal(reply["terminal_label"], `coagent/${coagentId}`);

  // 服务面：create 只调一次，且前台、cwd 与 label 正确；run 只调一次且命令就是 fffdsh。
  assert.equal(h.herdr.countOf("create"), 1);
  const created = h.herdr.lastCall("create");
  assert.deepEqual(created?.args[0], {
    foreground: true,
    cwd: h.parentCwd,
    label: `coagent/${coagentId}`,
  });
  assert.equal(h.herdr.countOf("run"), 1);
  assert.equal(h.herdr.lastCall("run")?.args[1], "fffdsh");

  // 记录落盘：索引 ready + meta.json + claim.log。
  const index = await indexOf(h);
  const record = recordsOf(index)[coagentId];
  assert.equal(record?.["state"], "ready");
  assert.equal(record?.["terminal_id"], reply["terminal_id"]);
  assert.equal(record?.["session_id"], "sess-child");
  assert.equal(record?.["cwd"], h.parentCwd);
  assert.equal(record?.["cmd"], "fffdsh");
  assert.equal(record?.["terminal_label"], `coagent/${coagentId}`);

  const meta = JSON.parse(
    await readArtifact(h, coagentId, "meta.json"),
  ) as Record<string, unknown>;
  assert.equal(meta["terminal_id"], reply["terminal_id"]);
  assert.match(
    await readArtifact(h, coagentId, "claim.log"),
    /认领到会话 sess-child/,
  );

  // 界面里能看到终端 label（herdr_list 的假实现）。
  const listed = await h.herdr.list();
  assert.equal(listed.ok, true);
});

test("T2 只走服务面：不 import 其他包、不自己起进程", async () => {
  // 结构面断言：源码只 import node: 内置与本包相对路径（见 guard.test.ts 的静态检查）。
  const h = await harness();
  schedulePeer(h);
  const reply = await h.spawn();
  assert.equal(reply["ok"], true);
  // 拉起全程只发生 create / run / read / info 四类服务面调用（无 close）。
  const methods = new Set(h.herdr.calls.map((call) => call.method));
  for (const method of methods) {
    assert.ok(
      ["create", "run", "read", "info", "list", "close"].includes(method),
      `出现了未预期的服务面方法 ${method}`,
    );
  }
  assert.equal(h.herdr.countOf("close"), 0);
});

test("T3 前台约束：已删除的 target / task 被拒，脱管痕迹被守门拒绝", async () => {
  const h = await harness();

  const withTarget = await h.spawn({ target: "tab" });
  assert.equal(withTarget["ok"], false);
  assert.equal(withTarget["error"], "invalid_params");
  assert.match(String(withTarget["next"]), /target 已随终端单层契约删除/);
  assert.equal(h.herdr.countOf("create"), 0);

  const withTask = await h.spawn({ task: "写个报告" });
  assert.equal(withTask["ok"], false);
  assert.equal(withTask["error"], "invalid_params");
  assert.match(String(withTask["next"]), /channel_delegate/);
  assert.equal(h.herdr.countOf("create"), 0);

  // 参数被拒时不落记录（避免误操作挤满 maxRecords）。
  const index = await indexOf(h).catch(() => undefined);
  if (index !== undefined) {
    assert.equal(Object.keys(recordsOf(index)).length, 0);
  }

  // 守门函数：脱管痕迹一律拒；正常命令通过。
  const { checkForegroundText, LAUNCH_COMMAND } =
    await import("../src/launch.ts");
  assert.equal(LAUNCH_COMMAND, "fffdsh");
  assert.equal(checkForegroundText("fffdsh").ok, true);
  for (const text of [
    "nohup fffdsh &",
    "setsid fffdsh",
    "fffdsh &",
    "fffdsh; disown",
    "bg fffdsh",
    "screen -dm fffdsh",
    "tmux new -d fffdsh",
  ]) {
    assert.equal(checkForegroundText(text).ok, false, `应拒绝：${text}`);
  }
});

test("T4 建终端失败（F2）：terminal_create_failed、不调 close、落 failed 记录", async () => {
  const h = await harness();
  h.herdr.createError = {
    code: "herdr-cli-error",
    message: "workspace 不可用",
  };

  const reply = await h.spawn();

  assert.equal(reply["ok"], false);
  assert.equal(reply["error"], "terminal_create_failed");
  assert.match(String(reply["reason"]), /workspace 不可用/);
  assert.equal(h.herdr.countOf("close"), 0);

  const record = recordsOf(await indexOf(h))[String(reply["coagent_id"])];
  assert.equal(record?.["state"], "failed");
  assert.equal(record?.["fail_code"], "terminal_create_failed");
  assert.equal(record?.["terminal_id"], undefined);
});

test("T5 提交失败回滚（F3）：close 只调一次、落 failed 记录", async () => {
  const h = await harness();
  h.herdr.runError = { code: "herdr-cli-error", message: "send-text 失败" };

  const reply = await h.spawn();

  assert.equal(reply["ok"], false);
  assert.equal(reply["error"], "launch_failed");
  assert.match(String(reply["reason"]), /提交 fffdsh 失败/);
  assert.equal(h.herdr.countOf("close"), 1);

  const record = recordsOf(await indexOf(h))[String(reply["coagent_id"])];
  assert.equal(record?.["state"], "failed");
  assert.equal(record?.["fail_code"], "launch_failed");
  assert.equal(record?.["terminal_closed"], true);
});

test("T6 找不到 fffdsh（F4）：屏文本快速失败 + 回滚关终端", async () => {
  const h = await harness();
  h.herdr.screen = "bash: line 1: fffdsh: command not found";

  const reply = await h.spawn();

  assert.equal(reply["ok"], false);
  assert.equal(reply["error"], "launch_failed");
  assert.match(String(reply["reason"]), /找不到 `fffdsh`/);
  assert.match(String(reply["next"]), /登录 shell/);
  assert.equal(h.herdr.countOf("close"), 1);

  const coagentId = String(reply["coagent_id"]);
  const record = recordsOf(await indexOf(h))[coagentId];
  assert.equal(record?.["state"], "failed");
  assert.equal(record?.["fail_code"], "launch_failed");
  assert.match(String(record?.["screen_excerpt"]), /command not found/);
  assert.match(
    await readArtifact(h, coagentId, "screen.log"),
    /command not found/,
  );
});

test("T7 缺 API_KEY（F5）：next 指向 shell rc", async () => {
  const h = await harness();
  h.herdr.screen = "fffdsh: 环境中缺少 API_KEY。";

  const reply = await h.spawn();

  assert.equal(reply["ok"], false);
  assert.equal(reply["error"], "launch_failed");
  assert.match(String(reply["next"]), /shell rc/);
  assert.equal(h.herdr.countOf("close"), 1);

  const record = recordsOf(await indexOf(h))[String(reply["coagent_id"])];
  assert.equal(record?.["fail_code"], "launch_failed");
});

test("T8 认领超时（F6）：落 lost、终端不关、回执列三条原因", async () => {
  const h = await harness({ config: { claimTimeoutSec: 3 } });

  const reply = await h.spawn();

  assert.equal(reply["ok"], false);
  assert.equal(reply["error"], "claim_timeout");
  assert.match(String(reply["reason"]), /构建/);
  assert.match(String(reply["reason"]), /session-channel/);
  assert.match(String(reply["reason"]), /事件/);
  assert.match(String(reply["next"]), /coagent list/);
  assert.match(String(reply["next"]), /coagent close/);
  assert.equal(h.herdr.countOf("close"), 0);

  const coagentId = String(reply["coagent_id"]);
  const record = recordsOf(await indexOf(h))[coagentId];
  assert.equal(record?.["state"], "lost");
  assert.equal(record?.["fail_code"], "claim_timeout");
  assert.equal(record?.["terminal_closed"], undefined);
  assert.match(await readArtifact(h, coagentId, "claim.log"), /认领超时/);
});

test("T13 回滚失败（F3 变体）：仍落 failed 记录并标 rollback_failed", async () => {
  const h = await harness();
  h.herdr.runError = { code: "herdr-cli-error", message: "提交失败" };
  h.herdr.closeErrors = 1; // 回滚时的 close 也失败

  const reply = await h.spawn();

  assert.equal(reply["ok"], false);
  assert.equal(reply["error"], "launch_failed");
  assert.match(String(reply["next"]), /herdr_list/);
  assert.match(String(reply["next"]), /herdr_close/);

  const record = recordsOf(await indexOf(h))[String(reply["coagent_id"])];
  assert.equal(record?.["state"], "failed");
  assert.equal(record?.["rollback_failed"], true);
  assert.equal(record?.["terminal_closed"], false);
});

test("spawn 参数缺省调用方 cwd，且 spawn 之间串行（不抢同一新会话）", async () => {
  const h = await harness();
  schedulePeer(h);
  const reply = await h.spawn();
  assert.equal(reply["ok"], true);
  const record = recordsOf(await indexOf(h))[String(reply["coagent_id"])];
  assert.equal(record?.["cwd"], h.parentCwd);
  assert.equal(record?.["session_id"], "sess-child");
  assert.equal(record?.["coagent_id"], reply["coagent_id"]);

  // 两个新会话从第一轮就在线：进程级锁保证第一个 spawn 落盘后第二个才读索引，
  // 第二个 spawn 的 known 已含第一个会话，故不会认领到同一个。
  const startedAt = h.clock.now();
  h.channel.addPeer({
    sessionId: "sess-a",
    pid: 5001,
    cwd: h.parentCwd,
    profile: PROFILE,
    startedAt,
  });
  h.channel.addPeer({
    sessionId: "sess-b",
    pid: 5002,
    cwd: h.parentCwd,
    profile: PROFILE,
    startedAt: startedAt + 1,
  });
  const [first, second] = await Promise.all([h.spawn(), h.spawn()]);
  assert.equal(first["ok"], true);
  assert.equal(second["ok"], true);
  assert.equal(h.herdr.countOf("create"), 3);
  assert.notEqual(first["terminal_id"], second["terminal_id"]);
  assert.notEqual(first["session_id"], second["session_id"]);
});

test("未挂 sessionPaths 时降级到 $DSH_HOME/coagent/<会话 id>/", async () => {
  const h = await harness({ withPaths: false });
  schedulePeer(h);

  const reply = await h.spawn();

  assert.equal(reply["ok"], true);
  const coagentId = String(reply["coagent_id"]);
  const indexPath = join(h.dir, "dsh-home", "coagent", PARENT, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(recordsOf(index)[coagentId]?.["state"], "ready");
});
