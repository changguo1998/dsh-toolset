/**
 * `ctx.fs` 读写路径测试（`hash-edit/src/ctx-fs-io.ts` + `hash-edit/src/fs.ts`）：
 * - 读窗口与哈希经 `ctx.fs` 稳定（行号 1 基、全文哈希 64 位 hex）;
 * - 锚点 stale：整批拒绝、文件字节不变;
 * - 非法 UTF-8：`not_utf8`，不写盘;
 * - 写成功：`replaceIfVersion` 意图经 `fs/write-intent` 瀑布, 写后留 `fs/observed`;
 * - 后端 stale：版本守卫拒绝 → `stale`;
 * - sandbox 拒绝：`sandbox_denied` + `[sandbox: …]` 原文透出;
 * - 目录列表：`listDir` 经 io;
 * - `ctx.fs` 缺失：不回落 node 标准库, 返回可行动错误。
 *
 * 文件落盘走假 `ctx.fs`（真写临时目录）。
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";

import { hashlines } from "../src/hashline.ts";
import type { HashFileIo } from "../src/io.ts";
import { listDir } from "../src/fs.ts";
import { assemble, makeWorkspace } from "./assemble.ts";
import type { Assembled } from "./assemble.ts";

const CONTENT = "alpha\nbeta\ngamma\n";

/** 取某行的锚点（`行号:哈希`）。 */
function anchorAt(content: string, line: number): string {
  const row = hashlines(content)[line - 1];
  assert.ok(row !== undefined);
  return `${row.line}:${row.hash}`;
}

/** 会话上下文（假 workingDirectory 读 `agent.session.header.cwd`）。 */
function execAt(dir: string): {
  agent: { session: { header: { cwd: string } } };
} {
  return { agent: { session: { header: { cwd: dir } } } };
}

/** 一次「写入成功」的工具往返（供多个断言复用）。 */
async function writeOnce(
  host: Assembled,
  file: string,
  exec: unknown,
): Promise<void> {
  const value = (await host.execute(
    "hash_edit",
    {
      path: file,
      edits: [{ set_line: { anchor: anchorAt(CONTENT, 1), new_text: "A1" } }],
    },
    exec,
  )) as { ok?: boolean; code?: string };
  assert.equal(value.ok, true, JSON.stringify(value));
}

test("hash_read: 读窗口与哈希稳定（1 基行号 + 64 位全文哈希）", async () => {
  const ws = await makeWorkspace({ "sample.txt": CONTENT });
  try {
    const host = await assemble();
    const value = (await host.execute(
      "hash_read",
      { path: ws.path("sample.txt"), offset: 2, limit: 2 },
      execAt(ws.dir),
    )) as {
      ok?: boolean;
      line_count?: number;
      file_hash?: string;
      hashlines?: Array<{ line: number; hash: string; text: string }>;
    };
    assert.equal(value.ok, true);
    assert.equal(value.line_count, 3);
    assert.match(String(value.file_hash), /^[0-9a-f]{64}$/);
    assert.deepEqual(
      value.hashlines?.map((row) => row.line),
      [2, 3],
      "窗口 1 基且按行号返回",
    );
    assert.equal(value.hashlines?.[0]?.text, "beta");
    assert.ok(
      host.observations.some((record) => record.event === "fs/observed"),
      "读后留一条观察记录",
    );
  } finally {
    await ws.cleanup();
  }
});

test("hash_edit 锚点 stale: 整批拒绝, 文件字节不变", async () => {
  const ws = await makeWorkspace({ "sample.txt": CONTENT });
  try {
    const host = await assemble();
    const value = (await host.execute(
      "hash_edit",
      {
        path: ws.path("sample.txt"),
        edits: [
          { set_line: { anchor: `${1}:deadbeef`, new_text: "X" } },
          { delete_line: { anchor: anchorAt(CONTENT, 3) } },
        ],
      },
      execAt(ws.dir),
    )) as { ok?: boolean; code?: string; details?: unknown };
    assert.equal(value.ok, false);
    assert.equal(value.code, "stale_anchors");
    assert.match(JSON.stringify(value.details), /deadbeef/);
    assert.equal(host.fs?.writes.length, 0, "锚点校验失败不触达写入");
  } finally {
    await ws.cleanup();
  }
});

test("非法 UTF-8: not_utf8, 不写盘", async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.path("bin.bin"), Buffer.from([0xff, 0xfe, 0x00]));
    const host = await assemble();
    const readValue = (await host.execute(
      "hash_read",
      { path: ws.path("bin.bin") },
      execAt(ws.dir),
    )) as { code?: string };
    assert.equal(readValue.code, "not_utf8");
    const editValue = (await host.execute(
      "hash_edit",
      {
        path: ws.path("bin.bin"),
        edits: [{ delete_line: { anchor: `${1}:deadbeef` } }],
      },
      execAt(ws.dir),
    )) as { code?: string };
    assert.equal(editValue.code, "not_utf8");
    assert.equal(host.fs?.writes.length, 0, "拒绝后不落盘");
  } finally {
    await ws.cleanup();
  }
});

test("写成功: 带 replaceIfVersion 意图, 经 fs/write-intent 瀑布与 fs/observed", async () => {
  const ws = await makeWorkspace({ "sample.txt": CONTENT });
  try {
    const host = await assemble();
    const before = await host.fs?.service.stat({
      targetKey: ws.path("sample.txt"),
      displayPath: ws.path("sample.txt"),
    });
    await writeOnce(host, ws.path("sample.txt"), execAt(ws.dir));

    assert.equal(host.fs?.writes.length, 1, "恰好一次 writeText");
    assert.deepEqual(host.fs?.writes[0]?.intent, {
      kind: "replaceIfVersion",
      version: before?.version,
    });
    assert.equal(host.waterfalls.length, 1, "写入前取一次意图");
    assert.equal(host.waterfalls[0]?.event, "fs/write-intent");
    assert.deepEqual(host.waterfalls[0]?.delegated, host.fs?.writes[0]?.intent);
    assert.ok(
      host.observations.some((record) => record.event === "fs/observed"),
      "写后留一条观察记录",
    );
  } finally {
    await ws.cleanup();
  }
});

test("后端 stale: 版本守卫拒绝 → stale, 文件不变", async () => {
  const ws = await makeWorkspace({ "sample.txt": CONTENT });
  try {
    const host = await assemble();
    host.fs?.failNextWrite(
      Object.assign(new Error("cannot write: file changed since it was read"), {
        code: "FS_STALE_VERSION",
      }),
    );
    const value = (await host.execute(
      "hash_edit",
      {
        path: ws.path("sample.txt"),
        edits: [{ set_line: { anchor: anchorAt(CONTENT, 1), new_text: "A1" } }],
      },
      execAt(ws.dir),
    )) as { ok?: boolean; code?: string; error?: string };
    assert.equal(value.ok, false);
    assert.equal(value.code, "stale");
    assert.match(String(value.error), /file changed since read/);
  } finally {
    await ws.cleanup();
  }
});

test("sandbox 拒绝: sandbox_denied 且原文透出（含[升级指引]）", async () => {
  const ws = await makeWorkspace({ "sample.txt": CONTENT });
  try {
    const host = await assemble();
    const denial =
      '[sandbox: workspace-write] cannot write "sample.txt": file access denied under workspace-write mode\n' +
      "[sandbox hint] retry with sandbox_permissions";
    host.fs?.failNextWrite(
      Object.assign(new Error(denial), { code: "FS_SANDBOX_DENIED" }),
    );
    const value = (await host.execute(
      "hash_edit",
      {
        path: ws.path("sample.txt"),
        edits: [{ set_line: { anchor: anchorAt(CONTENT, 1), new_text: "A1" } }],
      },
      execAt(ws.dir),
    )) as { ok?: boolean; code?: string; error?: string };
    assert.equal(value.ok, false);
    assert.equal(value.code, "sandbox_denied");
    assert.match(String(value.error), /\[sandbox: workspace-write\]/);
    assert.match(String(value.error), /sandbox_permissions/);
  } finally {
    await ws.cleanup();
  }
});

test("目录列表: listDir 经 io 给出条目名", async () => {
  const ws = await makeWorkspace({
    "sample.txt": CONTENT,
    "other.md": "# x\n",
  });
  try {
    const host = await assemble();
    const io = host.fs?.service as unknown as HashFileIo;
    const names = await listDir(ws.dir, io);
    assert.deepEqual(names.sort(), ["other.md", "sample.txt"]);
  } finally {
    await ws.cleanup();
  }
});

test("ctx.fs 缺失: 不回落 node 标准库, 返回可行动错误", async () => {
  const ws = await makeWorkspace({ "sample.txt": CONTENT });
  try {
    const host = await assemble({ fs: false });
    const value = (await host.execute(
      "hash_read",
      { path: ws.path("sample.txt") },
      execAt(ws.dir),
    )) as { ok?: boolean; error?: string };
    assert.equal(value.ok, false);
    assert.match(String(value.error), /ctx\.fs 不可用/);
  } finally {
    await ws.cleanup();
  }
});
