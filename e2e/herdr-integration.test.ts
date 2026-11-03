import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import { bootPackage, waitFor } from "./harness.ts";

test("herdr_integration 经 unix socket 上报根会话", async (t) => {
  const socketPath = join(
    process.cwd(),
    "tmp",
    "e2e",
    `herdr-${process.pid}.sock`,
  );
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      lines.push(chunk.toString());
      if (socket.writable) {
        try {
          socket.write('{"ok":true}\n');
        } catch {
          // 对端已关闭：上报内容已记录，回复失败不影响断言
        }
      }
    });
  });
  const host = await bootPackage("herdr-integration", {
    prepare: () =>
      new Promise<void>((resolve) => server.listen(socketPath, resolve)),
    env: {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PANE_ID: "pane-e2e",
    },
  });
  t.after(async () => {
    await host.dispose();
    server.close();
  });

  const agent = await host.createAgent("e2e-herdr-integration");
  host.ctx.emit("agent/status", { agent: agent.agent, status: "idle" });
  await waitFor(
    () => lines.some((line) => line.includes("pane.report_agent_session")),
    "未收到 pane 上报",
  );
  assert.ok(
    lines.some((line) => line.includes("pane.report_agent_session")),
    lines.join("").slice(0, 300),
  );
  await agent.dispose();
});
