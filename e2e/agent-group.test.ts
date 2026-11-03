import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, textOf, waitFor } from "./harness.ts";

test("agent_group 在真实宿主里建组并查看状态", async (t) => {
  let redis: ReturnType<typeof spawn> | undefined;
  const socketPath = join(
    process.cwd(),
    "tmp",
    "e2e",
    `agent-group-redis-${process.pid}.sock`,
  );
  const host = await bootPackage("agent-group", {
    extraPackages: ["session-channel", "session-paths"],
    prepare: async (home) => {
      const dataDir = join(home, "redis");
      mkdirSync(dataDir, { recursive: true });
      redis = spawn(
        "redis-server",
        [
          "--port",
          "0",
          "--unixsocket",
          socketPath,
          "--unixsocketperm",
          "700",
          "--dir",
          dataDir,
          "--save",
          "",
          "--appendonly",
          "no",
        ],
        { stdio: "ignore" },
      );
      await waitFor(
        () => existsSync(socketPath),
        "Redis unix socket 未就绪",
        5_000,
      );
    },
    patch: () =>
      `- id: session-channel\n  config:\n    url: ${JSON.stringify(socketPath)}\n`,
  });
  t.after(async () => {
    await host.dispose();
    redis?.kill("SIGTERM");
  });

  const agent = await host.createAgent("e2e-group");
  t.after(async () => agent.dispose());

  const created = await host.callTool(
    "agent_group",
    { action: "create_group", group: "e2e" },
    { agent: agent.agent },
  );
  assert.equal(created.isError, false, textOf(created));

  const group =
    (JSON.parse(textOf(created)) as { group?: string; name?: string }).group ??
    "group-1";
  const status = await host.callTool(
    "agent_group",
    { action: "status", group },
    { agent: agent.agent },
  );
  assert.equal(status.isError, false, textOf(status));
  assert.match(textOf(status), new RegExp(group));
});
