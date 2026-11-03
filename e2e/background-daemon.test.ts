import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("daemon_task 新建任务并把任务表落盘", async (t) => {
  const host = await bootPackage("background-daemon", {
    patch: (home) =>
      [
        "- id: background-daemon",
        "  config:",
        `    storePath: ${JSON.stringify(`${home}/background-daemon/tasks.json`)}`,
        "    enabled: true",
        '    defaultSessionId: "e2e-daemon"',
        "",
      ].join("\n"),
  });
  t.after(async () => host.dispose());

  const created = await host.callTool("daemon_task", {
    action: "create",
    selector: { kind: "after_seconds", seconds: 3600 },
    payload: "端到端提示",
  });
  assert.equal(created.isError, false, textOf(created));
  const taskId =
    (JSON.parse(textOf(created)) as { id?: string; task?: { id?: string } })
      .id ??
    (JSON.parse(textOf(created)) as { task?: { id?: string } }).task?.id;
  assert.ok(taskId, textOf(created));

  const store = join(host.home, "background-daemon", "tasks.json");
  assert.equal(existsSync(store), true, store);
  const saved = JSON.parse(readFileSync(store, "utf8")) as {
    tasks: { id: string; payload: string }[];
  };
  assert.equal(saved.tasks.length, 1, readFileSync(store, "utf8"));
  assert.equal(saved.tasks[0]?.id, taskId);
  assert.equal(saved.tasks[0]?.payload, "端到端提示");

  const shown = await host.callTool("daemon_task", {
    action: "show",
    id: taskId,
  });
  assert.equal(shown.isError, false, textOf(shown));
});
