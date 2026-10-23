/**
 * tests/close.test.ts — T9 至 T11：优雅关闭、关闭失败与强制、外部关闭后的幂等归档。
 *
 * 断言口径按新契约：关闭只有 `close(terminal_id)`（关整个终端），没有 closePane / closeTab。
 */

import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { afterEach, test } from "node:test";

import {
  createHarness,
  readIndex,
  schedulePeer,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness !== undefined) await harness.cleanup();
  }
});

async function harness(): Promise<Harness> {
  const created = await createHarness();
  harnesses.push(created);
  return created;
}

/** 拉起一条 ready 记录（认领在第一次 sleep 后命中）。 */
async function spawnReady(
  h: Harness,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  schedulePeer(h);
  const reply = await h.spawn(args);
  assert.equal(reply["ok"], true);
  assert.equal(reply["state"], "ready");
  return reply;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("T9 close 优雅：/quit 后关终端、删记录目录并留墓碑", async () => {
  const h = await harness();
  const spawned = await spawnReady(h);
  const coagentId = String(spawned["coagent_id"]);
  const terminalId = String(spawned["terminal_id"]);

  const reply = await h.close({ coagent_id: coagentId });

  assert.equal(reply["ok"], true);
  assert.equal(reply["state"], "closed");
  assert.equal(reply["closed_with"], "quit");
  assert.equal(reply["terminal_id"], terminalId);
  assert.equal(reply["removed_files"], true);

  // 先 /quit 再 close；close 只调一次。
  assert.equal(h.herdr.countOf("close"), 1);
  const runCommands = h.herdr.calls
    .filter((call) => call.method === "run")
    .map((call) => call.args[1]);
  assert.deepEqual(runCommands, ["fffdsh", "/quit"]);
  assert.equal(h.herdr.terminals.has(terminalId), false);

  // 记录目录已删，索引留墓碑。
  assert.equal(await exists(h.recordDir(coagentId)), false);
  const index = await readIndex(h);
  const record = index.records[coagentId];
  assert.equal(record?.["state"], "closed");
  assert.equal(record?.["pruned"], true);
  assert.equal(record?.["close_reason"], "quit");

  // 幂等：再 close 一次。
  const again = await h.close({ coagent_id: coagentId });
  assert.equal(again["ok"], true);
  assert.equal(again["already_closed"], true);
  assert.equal(h.herdr.countOf("close"), 1);
});

test("T10 close 失败与强制（F8）：close_failed 留 closing，force 成功", async () => {
  const h = await harness();
  const spawned = await spawnReady(h);
  const coagentId = String(spawned["coagent_id"]);
  const terminalId = String(spawned["terminal_id"]);

  h.herdr.closeErrors = 1; // 优雅路径最后一次 close 失败

  const failed = await h.close({ coagent_id: coagentId });

  assert.equal(failed["ok"], false);
  assert.equal(failed["error"], "close_failed");
  assert.match(String(failed["next"]), /force/);
  assert.equal(h.herdr.countOf("close"), 1);
  assert.equal(h.herdr.terminals.has(terminalId), true);

  // 记录留在 closing，目录未删。
  let index = await readIndex(h);
  assert.equal(index.records[coagentId]?.["state"], "closing");
  assert.equal(await exists(h.recordDir(coagentId)), true);

  // force 直接关终端（不再 /quit）。
  const forced = await h.close({ coagent_id: coagentId, force: true });
  assert.equal(forced["ok"], true);
  assert.equal(forced["closed_with"], "terminal_close");
  assert.equal(forced["state"], "closed");
  assert.equal(h.herdr.terminals.has(terminalId), false);
  assert.equal(h.herdr.countOf("close"), 2);

  index = await readIndex(h);
  assert.equal(index.records[coagentId]?.["state"], "closed");
  assert.equal(index.records[coagentId]?.["close_reason"], "terminal_close");
});

test("T11 外部关闭（F7）：list 判 lost，close 幂等归档并标 archived_from", async () => {
  const h = await harness();
  const spawned = await spawnReady(h);
  const coagentId = String(spawned["coagent_id"]);
  const terminalId = String(spawned["terminal_id"]);

  // 用户在 herdr 里手动关掉终端（假服务面里直接移除）。
  h.herdr.terminals.delete(terminalId);

  const listed = await h.list();
  assert.equal(listed["ok"], true);
  const items = listed["items"] as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.["state"], "lost");
  assert.equal(items[0]?.["terminal_running"], false);

  const index = await readIndex(h);
  assert.equal(index.records[coagentId]?.["state"], "lost");

  const closed = await h.close({ coagent_id: coagentId });
  assert.equal(closed["ok"], true);
  assert.equal(closed["state"], "closed");
  assert.equal(closed["archived_from"], "lost");
  assert.equal(h.herdr.terminals.has(terminalId), false);

  const after = await readIndex(h);
  assert.equal(after.records[coagentId]?.["state"], "closed");
});

test("close 的 not_found / 参数校验", async () => {
  const h = await harness();

  const missing = await h.close({ coagent_id: "c-deadbeef" });
  assert.equal(missing["ok"], false);
  assert.equal(missing["error"], "not_found");

  const noId = await h.tool.execute({ action: "close" }, h.exec);
  assert.equal(noId["ok"], false);
  assert.equal(noId["error"], "invalid_params");

  const typo = await h.tool.execute(
    { action: "close", coagent_id: "c-deadbeef", coagentId: "x" },
    h.exec,
  );
  assert.equal(typo["ok"], false);
  assert.equal(typo["error"], "invalid_params");
  assert.match(String(typo["next"]), /coagent_id \/ force \/ keep/);
});

test("close keep=true 保留记录目录", async () => {
  const h = await harness();
  const spawned = await spawnReady(h);
  const coagentId = String(spawned["coagent_id"]);

  const reply = await h.close({ coagent_id: coagentId, keep: true });

  assert.equal(reply["ok"], true);
  assert.equal(reply["removed_files"], false);
  assert.equal(await exists(h.recordDir(coagentId)), true);
  const index = await readIndex(h);
  assert.equal(index.records[coagentId]?.["pruned"], undefined);
});
