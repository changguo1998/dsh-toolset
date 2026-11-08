/**
 * `ctx.fs` 读写路径测试（`md-logic/src/ctx-fs-io.ts` + `md-logic/src/edit.ts` 的写面）：
 * - 成功替换：写入意图带读到的版本, 且经 `fs/write-intent` 瀑布与 `fs/observed` 观察;
 * - stale 拒绝：后端版本守卫拒绝 → `file_changed`, 文件不变;
 * - 超限：上限判定取后端 `FsInfo.size`, 不落盘;
 * - 非常规文件：目录一律 `read_failed`;
 * - 半成品：写失败（含沙箱拒绝原文透出）时文件字节不变;
 * - `ctx.fs` 缺失时不回落 `node:fs`, 返回可行动错误;
 * - 沙箱策略按 `agent.session` 解析; 相对路径基准由 `ctx.workingDirectory.ensure` 给。
 *
 * 文件落盘走假 `ctx.fs`（真写临时目录）。
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { findSections, parseMarkdownDocument } from "../src/index.ts";
import { assemble } from "./assemble.ts";
import type { AssembledHost } from "./assemble.ts";
import { withTempDir } from "./helpers.ts";

const DOC = [
  "# 标题",
  "",
  "前言。",
  "",
  "## 甲节",
  "",
  "甲的正文。",
  "",
  "## 乙节",
  "",
  "乙的正文。",
  "",
].join("\n");

/** 取某节的行范围（与 `structure` 输出同口径）。 */
function rangeOf(
  text: string,
  title: string,
): {
  startLine: number;
  endLine: number;
} {
  const row = findSections(parseMarkdownDocument(text)).find(
    (section) => section.title === title,
  );
  if (row === undefined) throw new Error(`没有该节：${title}`);
  return { startLine: row.line, endLine: row.endLine };
}

/** 一条替换入参（改写乙节；工具面用 snake_case 行号）。 */
function replaceArgs(path: string): Record<string, unknown> {
  const range = rangeOf(DOC, "乙节");
  return {
    action: "replace",
    path,
    edits: [
      {
        heading: "乙节",
        start_line: range.startLine,
        end_line: range.endLine,
        content: "## 乙节\n\n改后。",
      },
    ],
  };
}

/** 在临时目录里跑一次用例：装好的宿主 + 已写入的目标文件 + 会话上下文。 */
async function withHost(
  run: (context: {
    file: string;
    dir: string;
    host: AssembledHost;
    exec: { agent: { session: { header: { cwd: string } } } };
  }) => Promise<void>,
  options: {
    maxBytes?: number;
    sandboxMode?: string;
    services?: Record<string, unknown>;
    fs?: false;
  } = {},
): Promise<void> {
  const { dir, cleanup } = withTempDir();
  try {
    const host = assemble({
      ...(options.maxBytes === undefined
        ? {}
        : { config: { maxBytes: options.maxBytes } }),
      ...(options.fs === false
        ? { fs: false as const }
        : options.sandboxMode === undefined
          ? {}
          : { fs: { sandboxMode: options.sandboxMode } }),
      ...(options.services === undefined ? {} : { services: options.services }),
    });
    const file = `${dir}/a.md`;
    writeFileSync(file, DOC, "utf8");
    await run({
      file,
      dir,
      host,
      exec: { agent: { session: { header: { cwd: dir } } } },
    });
  } finally {
    cleanup();
  }
}

test("md_logic replace: 成功替换带 replaceIfVersion 意图, 经瀑布与观察", async () => {
  await withHost(async ({ file, host, exec }) => {
    const before = await host.fs?.service.stat({
      targetKey: file,
      displayPath: file,
    });
    const value = (await host.tools
      .require("md_logic")
      .execute(replaceArgs("a.md"), exec)) as {
      ok?: boolean;
      applied?: number;
      code?: string;
    };

    assert.equal(value.ok, true, JSON.stringify(value));
    assert.equal(value.applied, 1);
    assert.match(readFileSync(file, "utf8"), /改后。/);

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
      "读后与写后各留一条观察记录",
    );
  });
});

test("md_logic replace stale: 后端版本守卫拒绝 → file_changed, 文件不变", async () => {
  await withHost(async ({ file, host, exec }) => {
    host.fs?.failNextWrite(
      Object.assign(new Error("cannot write: file changed since it was read"), {
        code: "FS_STALE_VERSION",
      }),
    );
    const value = (await host.tools
      .require("md_logic")
      .execute(replaceArgs("a.md"), exec)) as {
      ok?: boolean;
      code?: string;
      error?: string;
    };

    assert.equal(value.ok, false);
    assert.equal(value.code, "file_changed");
    assert.match(String(value.error), /重新 structure/);
    assert.equal(readFileSync(file, "utf8"), DOC, "拒绝后不落盘");
  });
});

test("md_logic replace 超限: 上限判定取后端 size, 不落盘", async () => {
  await withHost(
    async ({ file, host, exec }) => {
      const value = (await host.tools
        .require("md_logic")
        .execute(replaceArgs("a.md"), exec)) as {
        ok?: boolean;
        code?: string;
        error?: string;
      };

      assert.equal(value.ok, false);
      assert.equal(value.code, "read_failed");
      assert.match(String(value.error), /超过上限 16B/);
      assert.equal(host.fs?.writes.length, 0, "超限不应触达写入");
      assert.equal(readFileSync(file, "utf8"), DOC);
    },
    { maxBytes: 16 },
  );
});

test("md_logic replace 非常规文件: 目录一律 read_failed", async () => {
  await withHost(async ({ dir, host, exec }) => {
    const value = (await host.tools
      .require("md_logic")
      .execute(
        { action: "replace", path: dir, edits: replaceArgs(dir)["edits"] },
        exec,
      )) as { ok?: boolean; code?: string; error?: string };

    assert.equal(value.ok, false);
    assert.equal(value.code, "read_failed");
    assert.match(String(value.error), /目标不是常规文件/);
  });
});

test("md_logic replace 半成品: 写失败（沙箱拒绝原文透出）时文件字节不变", async () => {
  await withHost(async ({ file, host, exec }) => {
    const denial =
      '[sandbox: workspace-write] cannot write "a.md": file access denied under workspace-write mode\n' +
      "[sandbox hint] retry with sandbox_permissions";
    host.fs?.failNextWrite(
      Object.assign(new Error(denial), { code: "FS_SANDBOX_DENIED" }),
    );
    const value = (await host.tools
      .require("md_logic")
      .execute(replaceArgs("a.md"), exec)) as {
      ok?: boolean;
      code?: string;
      error?: string;
    };

    assert.equal(value.ok, false);
    assert.equal(value.code, "write_failed");
    assert.match(
      String(value.error),
      /\[sandbox: workspace-write\]/,
      "原文透出",
    );
    assert.match(String(value.error), /sandbox_permissions/);
    assert.equal(readFileSync(file, "utf8"), DOC, "写失败不得改动原文件");
  });
});

test("md_logic: ctx.fs 缺失时不回落 node:fs, 返回可行动错误", async () => {
  await withHost(
    async ({ file, host, exec }) => {
      const value = (await host.tools
        .require("md_logic")
        .execute(replaceArgs("a.md"), exec)) as { error?: string };
      assert.match(String(value.error), /ctx\.fs 不可用/);
      assert.equal(readFileSync(file, "utf8"), DOC, "缺服务时绝不落盘");
    },
    { fs: false },
  );
});

test("md_logic 沙箱策略: 围栏后端按 agent.session 解析, 不围栏不解析", async () => {
  const resolved: unknown[] = [];
  const policy = { mode: "workspace-write", workspaceRoot: "/w" };
  const policyService = {
    resolve(opts?: { session?: unknown }): unknown {
      resolved.push(opts);
      return policy;
    },
  };

  await withHost(
    async ({ host, exec }) => {
      await host.tools.require("md_logic").execute(replaceArgs("a.md"), exec);
      assert.equal(
        host.fs?.writes[0]?.sandboxPolicy,
        undefined,
        "不围栏时不传策略",
      );
      assert.deepEqual(resolved, [], "不围栏后端不解析策略");
    },
    { services: { sandboxPolicy: policyService } },
  );

  await withHost(
    async ({ host, exec }) => {
      await host.tools.require("md_logic").execute(replaceArgs("a.md"), exec);
      assert.deepEqual(resolved, [
        {
          session: {
            header: { cwd: (exec.agent.session.header as { cwd: string }).cwd },
          },
        },
      ]);
      assert.equal(host.fs?.writes[0]?.sandboxPolicy, policy);
    },
    {
      sandboxMode: "workspace-write",
      services: { sandboxPolicy: policyService },
    },
  );
});

test("md_logic 相对路径: cwd 由 ctx.workingDirectory.ensure 给", async () => {
  await withHost(async ({ host, exec }) => {
    await host.tools.require("md_logic").execute(replaceArgs("a.md"), exec);
    assert.equal(host.ensureCalls.length, 1, "解析路径时取一次会话目录");
    assert.deepEqual(host.ensureCalls[0], exec.agent);
  });
});
