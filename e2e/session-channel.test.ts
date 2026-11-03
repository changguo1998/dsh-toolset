import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, textOf, waitFor } from "./harness.ts";

test("session_channel 连本地 Redis 后可登记别名并留在键空间", async (t) => {
  let redis: ReturnType<typeof spawn> | undefined;
  const socketPath = join(
    process.cwd(),
    "tmp",
    "e2e",
    `redis-${process.pid}.sock`,
  );
  const host = await bootPackage("session-channel", {
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

  const agent = await host.createAgent("e2e-channel");
  t.after(async () => agent.dispose());

  const alias = await host.callTool(
    "session_channel",
    { action: "alias", op: "set", name: "e2e-self", sessionId: "e2e-channel" },
    { agent: agent.agent },
  );
  assert.equal(alias.isError, false, textOf(alias));

  const listed = await host.callTool(
    "session_channel",
    { action: "alias", op: "list" },
    { agent: agent.agent },
  );
  assert.equal(listed.isError, false, textOf(listed));
  assert.match(textOf(listed), /e2e-self/);

  const stored = execFileSync(
    "redis-cli",
    ["-s", socketPath, "GET", "dsh:session-channel:alias:e2e-self"],
    {
      encoding: "utf8",
    },
  ).trim();
  assert.equal(stored, "e2e-channel");
});
