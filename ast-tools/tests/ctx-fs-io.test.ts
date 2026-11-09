/**
 * `ctx.fs` 读写路径测试（`ast-tools/src/ctx-fs-io.ts` + `ast-tools/src/replace.ts` 的写面）：
 * - dry-run 只读不写（不调用 `writeText`）;
 * - write:true 的写入意图带读到的版本, 且经 `fs/write-intent` 瀑布;
 * - 后端 stale 拒绝转成中文可行动文案, 保 `FS_STALE_VERSION` 码;
 * - sandbox 拒绝原样透出（含 `[sandbox: …]` 标记与升档指引）;
 * - `ctx.fs` 缺失时不回落 `node:fs`, 返回可行动错误;
 * - 会话沙箱策略: 后端围栏时按 `agent.session` 解析并原样回传, 不围栏时不解析;
 * - 相对路径基准由 `ctx.workingDirectory.ensure` 给。
 *
 * 二进制用假 ast-grep 脚本（输出预置 JSON）, 文件落盘走假 `ctx.fs`（真写临时目录）。
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { AstFileError } from "../src/io.ts";
import { assemble, createFakeAstGrep } from "./assemble.ts";
import type { AssembledHost } from "./assemble.ts";
import { withTempDir } from "./helpers.ts";

/** 假 CLI 的 run 输出：一处替换（字节偏移 0..22）。 */
const RUN_PAYLOAD = [
  {
    text: "console.log(add(1, 2))",
    file: "a.ts",
    range: {
      start: { line: 0, column: 0 },
      end: { line: 0, column: 22 },
      byteOffset: { start: 0, end: 22 },
    },
    replacement: "logger.info(add(1, 2))",
    replacementOffsets: { start: 0, end: 22 },
  },
];

const ORIGINAL = "console.log(add(1, 2));\n";
const REPLACED = "logger.info(add(1, 2));\n";

/** 一条替换入参（`write` 由用例决定）。 */
function replaceArgs(file: string, write = false): Record<string, unknown> {
  return {
    pattern: "console.log($ARG)",
    replacement: "logger.info($ARG)",
    language: "ts",
    path: file,
    write,
  };
}

/** 在临时目录里跑一次用例：假 CLI + 装好的宿主 + 已写入的目标文件。 */
async function withHost(
  run: (context: { file: string; host: AssembledHost }) => Promise<void>,
  options: {
    sandboxMode?: string;
    services?: Record<string, unknown>;
    injectGuard?: boolean;
  } = {},
): Promise<void> {
  const cli = createFakeAstGrep({ run: RUN_PAYLOAD });
  const { dir, cleanup } = withTempDir();
  try {
    const host = assemble({
      config: { bin: cli.bin },
      ...(options.sandboxMode === undefined
        ? {}
        : { fs: { sandboxMode: options.sandboxMode } }),
      ...(options.services === undefined ? {} : { services: options.services }),
      ...(options.injectGuard === true ? { injectGuard: true } : {}),
    });
    const file = `${dir}/a.ts`;
    writeFileSync(file, ORIGINAL, "utf8");
    await run({ file, host });
  } finally {
    cli.cleanup();
    cleanup();
  }
}

test("ast_replace dry-run: 只读不写, 目标文件保持原样", async () => {
  await withHost(async ({ file, host }) => {
    const value = (await host.tools
      .require("ast_replace")
      .execute(replaceArgs(file))) as {
      updatedSource: string;
      written: boolean;
      replacedCount: number;
    };
    assert.equal(value.updatedSource, REPLACED);
    assert.equal(value.replacedCount, 1);
    assert.equal(value.written, false);
    assert.equal(host.fs?.writes.length, 0, "dry-run 不调用 writeText");
    assert.equal(readFileSync(file, "utf8"), ORIGINAL);
  });
});

test("ast_replace write:true: 写入意图带读到的版本, 经 fs/write-intent 瀑布", async () => {
  await withHost(async ({ file, host }) => {
    const before = await host.fs?.service.stat({
      targetKey: file,
      displayPath: file,
    });
    const value = (await host.tools
      .require("ast_replace")
      .execute(replaceArgs(file, true))) as { written: boolean };
    assert.equal(value.written, true);
    assert.equal(readFileSync(file, "utf8"), REPLACED);

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

test("ast_replace stale: 后端拒绝时整次失败, 文案提示重新读取", async () => {
  await withHost(async ({ file, host }) => {
    host.fs?.failNextWrite(
      Object.assign(new Error("cannot write: file changed since it was read"), {
        code: "FS_STALE_VERSION",
      }),
    );
    await assert.rejects(
      () => host.tools.require("ast_replace").execute(replaceArgs(file, true)),
      (error: unknown) => {
        assert.ok(error instanceof AstFileError);
        assert.equal(error.code, "FS_STALE_VERSION");
        assert.match(error.message, /重新读取后重试/);
        return true;
      },
    );
    assert.equal(readFileSync(file, "utf8"), ORIGINAL, "拒绝后不落盘");
  });
});

test("ast_replace sandbox: 围栏拒绝原样透出（含标记与升档指引）", async () => {
  await withHost(async ({ file, host }) => {
    const denial =
      '[sandbox: workspace-write] cannot write "a.ts": file access denied under workspace-write mode\n' +
      "[sandbox hint] retry with sandbox_permissions";
    host.fs?.failNextWrite(
      Object.assign(new Error(denial), { code: "FS_SANDBOX_DENIED" }),
    );
    await assert.rejects(
      () => host.tools.require("ast_replace").execute(replaceArgs(file, true)),
      (error: unknown) => {
        assert.ok(error instanceof AstFileError);
        assert.equal(error.code, "FS_SANDBOX_DENIED");
        assert.equal(error.message, denial, "拒绝文案原样透出");
        return true;
      },
    );
  });
});

test("ast_replace: ctx.fs 缺失时不回落 node:fs, 返回可行动错误", async () => {
  const cli = createFakeAstGrep({ run: RUN_PAYLOAD });
  const { dir, cleanup } = withTempDir();
  try {
    const host = assemble({ config: { bin: cli.bin }, fs: false });
    const file = `${dir}/a.ts`;
    writeFileSync(file, ORIGINAL, "utf8");
    await assert.rejects(
      () => host.tools.require("ast_replace").execute(replaceArgs(file, true)),
      (error: unknown) => {
        assert.ok(error instanceof AstFileError);
        assert.equal(error.code, "FS_UNAVAILABLE");
        assert.match(error.message, /ctx\.fs 不可用/);
        return true;
      },
    );
    assert.equal(readFileSync(file, "utf8"), ORIGINAL, "缺服务时绝不落盘");
  } finally {
    cli.cleanup();
    cleanup();
  }
});

test("ast_replace 沙箱策略: 围栏后端按 agent.session 解析, 不围栏不解析", async () => {
  const resolved: unknown[] = [];
  const policy = { mode: "workspace-write", workspaceRoot: "/w" };
  const policyService = {
    resolve(opts?: { session?: unknown }): unknown {
      resolved.push(opts);
      return policy;
    },
  };
  const exec = { agent: { session: { id: "s1" } } };

  await withHost(
    async ({ file, host }) => {
      await host.tools
        .require("ast_replace")
        .execute(replaceArgs(file, true), exec);
      assert.equal(host.fs?.writes.length, 1, "不围栏后端也照常写");
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
    async ({ file, host }) => {
      await host.tools
        .require("ast_replace")
        .execute(replaceArgs(file, true), exec);
      assert.deepEqual(resolved, [{ session: { id: "s1" } }]);
      assert.equal(host.fs?.writes[0]?.sandboxPolicy, policy);
    },
    {
      sandboxMode: "workspace-write",
      services: { sandboxPolicy: policyService },
    },
  );
});

test("ast_replace 相对路径: cwd 由 ctx.workingDirectory.ensure 给", async () => {
  await withHost(async ({ file, host }) => {
    const exec = { agent: { session: { id: "s1" } } };
    await host.tools.require("ast_replace").execute(replaceArgs(file), exec);
    assert.equal(host.ensureCalls.length, 1, "解析路径时取一次会话目录");
    assert.deepEqual(host.ensureCalls[0], {
      agent: exec.agent,
      signal: undefined,
    });
  });
});

test("宿主代理形态: 可选服务只经 ctx.get 读取, 属性直读不触发 inject 报错", async () => {
  await withHost(
    async ({ file, host }) => {
      const exec = { agent: { session: { id: "s1" } } };
      const value = (await host.tools
        .require("ast_replace")
        .execute(replaceArgs(file, true), exec)) as {
        written?: boolean;
        replacedCount?: number;
      };
      assert.equal(value.written, true, JSON.stringify(value));
      assert.equal(value.replacedCount, 1);
      assert.equal(host.fs?.writes[0]?.sandboxPolicy, "proxy-policy");
      assert.equal(host.ensureCalls.length, 1);
    },
    {
      injectGuard: true,
      sandboxMode: "workspace-write",
      services: { sandboxPolicy: { resolve: (): string => "proxy-policy" } },
    },
  );
});
