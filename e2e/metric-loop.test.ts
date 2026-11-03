import assert from "node:assert/strict";
import { test } from "node:test";

import { bootPackage, textOf } from "./harness.ts";

test("metric_loop 跑一轮测量并记下状态文件", async (t) => {
  const host = await bootPackage("metric-loop", {
    patch: (home) =>
      `- id: metric-loop\n  config:\n    stateDir: ${JSON.stringify(`${home}/metric-loop`)}\n`,
  });
  t.after(async () => host.dispose());

  const started = await host.callTool("metric_loop", {
    action: "start",
    id: "e2e",
    measureCmd: "echo 7",
    maxRounds: 2,
  });
  assert.equal(started.isError, false, textOf(started));
  const { readFileSync, readdirSync } = await import("node:fs");
  const files = readdirSync(`${host.home}/metric-loop`);
  assert.equal(files.length, 1, files.join(", "));
  const state = JSON.parse(
    readFileSync(`${host.home}/metric-loop/${files[0]}`, "utf8"),
  ) as {
    state?: { history?: unknown[]; best?: unknown };
  };
  assert.equal(state.state?.history?.length, 1, JSON.stringify(state));

  const status = await host.callTool("metric_loop", {
    action: "status",
    id: "e2e",
  });
  assert.equal(status.isError, false, textOf(status));
});
