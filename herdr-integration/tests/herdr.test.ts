// tests/herdr.test.ts — herdr 协议客户端单测
//
// readHerdrEnv 握手判定 + 真实 unix socket 端到端（消息形状 / seq 单调 / 会话引用随附）。
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HerdrClient, readHerdrEnv } from "../src/herdr.ts";

const tempSockets: string[] = [];
const openServers: Server[] = [];

after(() => {
  for (const server of openServers) {
    server.close();
  }
  for (const path of tempSockets) {
    rmSync(path, { recursive: true, force: true });
  }
});

/** 收集 socket 上行行的临时服务端（收到即回一行响应，让客户端首个 attempt 收尾）。 */
function createSocketServer(path: string): {
  lines: string[];
  listen(): Promise<void>;
  close(): Promise<void>;
} {
  const lines: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
      socket.write("ok\n");
    });
  });
  openServers.push(server);
  return {
    lines,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 等待服务端收到 n 行（带超时守卫，避免测试无限挂起）。 */
async function waitLines(
  lines: string[],
  n: number,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (lines.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${n} socket lines`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function tmpSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
  const path = join(dir, "test.sock");
  tempSockets.push(path);
  return path;
}

function clientFor(socketPath: string): HerdrClient {
  return new HerdrClient({
    paneId: "p1",
    socketPath,
    source: "herdr:dsh",
    agent: "dsh",
    attemptTimeoutMs: 200,
  });
}

describe("readHerdrEnv 握手判定", () => {
  test("HERDR_ENV=1 且 socket/pane 齐全 → 启用", () => {
    const opts = readHerdrEnv({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "p1",
    });
    assert.ok(opts);
    assert.equal(opts!.paneId, "p1");
    assert.equal(opts!.socketPath, "/tmp/herdr.sock");
    assert.equal(opts!.source, "herdr:dsh");
    assert.equal(opts!.agent, "dsh");
  });

  test("HERDR_ENV 非 1 → 禁用", () => {
    assert.equal(
      readHerdrEnv({
        HERDR_ENV: "0",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        HERDR_PANE_ID: "p1",
      }),
      undefined,
    );
  });

  test("socket 或 pane 缺失 → 禁用", () => {
    assert.equal(
      readHerdrEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }),
      undefined,
    );
    assert.equal(
      readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p1" }),
      undefined,
    );
  });
});

describe("HerdrClient unix socket 协议", () => {
  test("reportSession 发送 pane.report_agent_session（含会话引用与 seq）", async () => {
    const socketPath = tmpSocketPath();
    const { lines, listen, close } = createSocketServer(socketPath);
    await listen();
    const client = clientFor(socketPath);
    await client.reportSession({ id: "sess-1" }, "startup");

    assert.equal(lines.length, 1);
    const msg = JSON.parse(lines[0]!) as {
      method: string;
      params: Record<string, unknown>;
    };
    assert.equal(msg.method, "pane.report_agent_session");
    assert.equal(msg.params.pane_id, "p1");
    assert.equal(msg.params.source, "herdr:dsh");
    assert.equal(msg.params.agent, "dsh");
    assert.equal(msg.params.agent_session_id, "sess-1");
    assert.equal(msg.params.session_start_source, "startup");
    assert.ok(typeof msg.params.seq === "number");

    await close();
  });

  test("reportState 发送 pane.report_agent（id 优先于 path 的会话引用随附）", async () => {
    const socketPath = tmpSocketPath();
    const { lines, listen, close } = createSocketServer(socketPath);
    await listen();
    const client = clientFor(socketPath);
    client.setSessionRef({ id: "sess-1", path: "/sessions/sess-1.jsonl" });
    await client.reportState("blocked", "waiting for user");
    await waitLines(lines, 1);

    assert.equal(lines.length, 1);
    const msg = JSON.parse(lines[0]!) as {
      method: string;
      params: Record<string, unknown>;
    };
    assert.equal(msg.method, "pane.report_agent");
    assert.equal(msg.params.state, "blocked");
    assert.equal(msg.params.message, "waiting for user");
    // id 优先 → 只带 agent_session_id
    assert.equal(msg.params.agent_session_id, "sess-1");
    assert.equal(msg.params.agent_session_path, undefined);

    await close();
  });

  test("无会话引用时状态消息不带会话字段", async () => {
    const socketPath = tmpSocketPath();
    const { lines, listen, close } = createSocketServer(socketPath);
    await listen();
    const client = clientFor(socketPath);
    await client.reportState("idle");
    await waitLines(lines, 1);
    const msg = JSON.parse(lines[0]!) as {
      params: Record<string, unknown>;
    };
    assert.equal(msg.params.agent_session_id, undefined);
    assert.equal(msg.params.agent_session_path, undefined);
    await close();
  });

  test("seq 跨消息单调递增", async () => {
    const socketPath = tmpSocketPath();
    const { lines, listen, close } = createSocketServer(socketPath);
    await listen();
    const client = clientFor(socketPath);
    client.setSessionRef({ id: "sess-1" });
    await client.reportSession({ id: "sess-1" });
    await client.reportState("working");
    await waitLines(lines, 2);

    assert.equal(lines.length, 2);
    const seqs = lines.map(
      (line) => (JSON.parse(line) as { params: { seq: number } }).params.seq,
    );
    assert.ok(seqs[0]! < seqs[1]!);
    await close();
  });

  test("状态队列：同刻多条只发最新（合并去抖，丢弃中间态）", async () => {
    const socketPath = tmpSocketPath();
    const { lines, listen, close } = createSocketServer(socketPath);
    await listen();
    const client = clientFor(socketPath);
    client.setSessionRef({ id: "sess-1" });
    // 三次调用在首个 drain 完成前同步到达：working 已在发送中，
    // blocked 被 idle 覆盖 → 只落 working 与 idle 两条。
    await client.reportState("working");
    await client.reportState("blocked", "waiting for user");
    await client.reportState("idle");
    await waitLines(lines, 2);

    const states = lines.map(
      (line) =>
        (JSON.parse(line) as { params: { state: string } }).params.state,
    );
    assert.deepEqual(states, ["working", "idle"]);
    await close();
  });

  test("状态队列：逐条确认后串行保序", async () => {
    const socketPath = tmpSocketPath();
    const { lines, listen, close } = createSocketServer(socketPath);
    await listen();
    const client = clientFor(socketPath);
    client.setSessionRef({ id: "sess-1" });
    // 每条发完后等服务端收到，再发下一条 → 三条全部落盘且保序
    await client.reportState("working");
    await waitLines(lines, 1);
    await client.reportState("blocked", "waiting for user");
    await waitLines(lines, 2);
    await client.reportState("idle");
    await waitLines(lines, 3);

    const states = lines.map(
      (line) =>
        (JSON.parse(line) as { params: { state: string } }).params.state,
    );
    assert.deepEqual(states, ["working", "blocked", "idle"]);
    await close();
  });
});
