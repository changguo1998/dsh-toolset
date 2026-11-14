// tool-consult/tests/revealed-hold.test.ts — 每工具 pinNotes.hold 投递与隔离。

import { test } from "node:test";
import assert from "node:assert/strict";

import { resetSurfaceCatalog } from "@dsh-toolset/tool-surface";
import { assemble } from "./assemble.ts";

function fresh(options: Parameters<typeof assemble>[0] = {}) {
  resetSurfaceCatalog();
  return assemble(options);
}

test("每工具一 key：揭示前不登记，揭示后全文投递且同字节", async () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "hold-a" });
  assert.deepEqual(app.pinNotes.keys(), []);

  await app.executeText({ names: ["hash_read"] }, undefined, agent.id);
  assert.deepEqual(app.pinNotes.keys(), ["revealed:hash_read"]);
  const first = app.pinNotes.text("revealed:hash_read", agent.id);
  assert.ok(first);
  assert.match(first, /已揭示工具 hash_read/);
  assert.match(first, /按行号锚点读取的完整说明/);
  assert.equal(app.pinNotes.text("revealed:hash_read", agent.id), first);

  await app.executeText({ names: ["task_status"] }, undefined, agent.id);
  assert.deepEqual(app.pinNotes.keys().sort(), [
    "revealed:hash_read",
    "revealed:task_status",
  ]);
  const second = app.pinNotes.text("revealed:task_status", agent.id);
  assert.ok(second);
  assert.match(second, /查看任务状态的完整说明/);
  assert.equal(
    app.pinNotes.text("revealed:hash_read", agent.id),
    first,
    "新增揭示不重写旧工具的正文",
  );
});

test("多会话隔离：一个会话的揭示不投给另一个会话", async () => {
  const app = fresh();
  app.apply();
  const first = app.addAgent({ id: "hold-first" });
  const second = app.addAgent({ id: "hold-second" });
  await app.executeText({ names: ["hash_edit"] }, undefined, first.id);

  assert.ok(app.pinNotes.text("revealed:hash_edit", first.id));
  assert.equal(app.pinNotes.text("revealed:hash_edit", second.id), undefined);
  assert.equal(app.pinNotes.text("revealed:hash_edit", "missing"), undefined);
});

test("denied 工具不登记 hold", async () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "hold-denied" });
  await app.executeText({ names: ["team_task_list"] }, undefined, agent.id);
  assert.equal(app.pinNotes.keys().includes("revealed:team_task_list"), false);
});

test("插件卸载释放 hold；已移除运行时的 provider 返回 undefined", async () => {
  const app = fresh();
  app.apply();
  const agent = app.addAgent({ id: "hold-dispose" });
  await app.executeText({ names: ["hash_read"] }, undefined, agent.id);
  assert.equal(app.pinNotes.keys().length, 1);
  app.dispose();
  assert.deepEqual(app.pinNotes.keys(), []);
});

test("pinNotes 缺席：揭示照常授权，只告警", async () => {
  const app = fresh({ serviceValues: { pinNotes: undefined } });
  app.apply();
  const agent = app.addAgent({ id: "hold-missing" });
  const text = await app.executeText(
    { names: ["hash_read"] },
    undefined,
    agent.id,
  );
  assert.ok(text.includes("已揭示"));
  assert.ok(app.logs().some((line) => line.includes("ctx.pinNotes 不可用")));
  assert.deepEqual(
    agent.emit("tools/pre-execute", { name: "hash_read" }, () => ({
      kind: "allow",
    })),
    { kind: "allow" },
  );
});
