/**
 * tests/net.test.ts — 真实 unix socket 连接器（`createNetConnector`）
 *
 * 单测不依赖 herdr：本文件起一个**本地假服务端**，验证三件 CLI 层看不见的事——
 *   1. 响应**分片到达**时的 framing（只在收到换行后才算完整响应）；
 *   2. 服务端不回包时的超时归一（`timeout`，不抛错）；
 *   3. 连不上（socket 路径不存在）时的错误归一（`error`）。
 *
 * socket 路径放在临时目录（Linux / macOS 均可），用例结束删掉服务端与 socket 文件。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createNetConnector } from "../src/socket.ts";

/** 起一个本地假服务端，跑完用例后关闭并清理 socket 文件。 */
async function withServer(
  onConnection: (socket: net.Socket) => void,
  body: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "herdr-use-net-"));
  const socketPath = join(dir, "herdr.sock");
  // 服务端侧连接必须自己收好：客户端超时后直接 destroy，若这里从没读过数据，socket 会停在
  // paused 态，`server.close()` 就会一直等它——这是本轮「测试跑完不退出」的根因。
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.resume();
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    await body(socketPath);
  } finally {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(dir, { recursive: true, force: true });
  }
}

test("createNetConnector: 响应分两片到达时，收到换行才返回完整文本", async () => {
  await withServer(
    (socket) => {
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (!received.includes("\n")) return;
        // 第一片：不含换行（连接器必须继续等）
        socket.write('{"id":"x","result":{"type":"pane_read",');
        setTimeout(() => {
          // 第二片：补完并换行（协议按行分帧）
          socket.write('"read":{"text":"hi","revision":3}}}\n');
        }, 20);
      });
    },
    async (socketPath) => {
      const connector = createNetConnector();
      const response = await connector.request(
        socketPath,
        '{"id":"req","method":"pane.read"}\n',
        2000,
      );
      assert.equal(response.kind, "data");
      const text = response.kind === "data" ? response.text : "";
      // 返回的是**去换行**的一行，且两片已拼成一个完整 JSON
      assert.equal(text.endsWith("\n"), false);
      const parsed = JSON.parse(text) as {
        result: { read: { text: string; revision: number } };
      };
      assert.equal(parsed.result.read.text, "hi");
      assert.equal(parsed.result.read.revision, 3);
    },
  );
});

test("createNetConnector: 报文按原样写入（含结尾换行）", async () => {
  let received = "";
  await withServer(
    (socket) => {
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.includes("\n")) socket.write('{"id":"x","result":{}}\n');
      });
    },
    async (socketPath) => {
      const payload = '{"id":"req","method":"pane.read","params":{}}\n';
      const response = await createNetConnector().request(
        socketPath,
        payload,
        2000,
      );
      assert.equal(response.kind, "data");
      assert.equal(received, payload);
    },
  );
});

test("createNetConnector: 服务端不回包 → timeout（不抛错）", async () => {
  await withServer(
    () => {
      // 接了连接但永不写响应
    },
    async (socketPath) => {
      const response = await createNetConnector().request(
        socketPath,
        '{"id":"req"}\n',
        80,
      );
      assert.equal(response.kind, "timeout");
    },
  );
});

test("createNetConnector: socket 路径不存在 → error（带原因）", async () => {
  const missing = join(tmpdir(), `herdr-use-missing-${process.pid}.sock`);
  const response = await createNetConnector().request(
    missing,
    '{"id":"req"}\n',
    500,
  );
  assert.equal(response.kind, "error");
  assert.notEqual(
    response.kind === "error" ? response.message : "",
    "",
    "错误应带可读原因（如 ENOENT）",
  );
});
