/**
 * tests/cli.test.ts — 握手判定、二进制定位、响应信封解析与退出码归一
 *
 * 不依赖真机 herdr：所有函数都是纯函数或可注入面，PATH 探测用临时目录自造可执行文件。
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyExit,
  commandLabel,
  createDefaultRunner,
  extractJsonObject,
  findOnPath,
  parseEnvelope,
  probeHerdrServerSync,
  readHerdrHandshake,
  resolveHerdrBin,
} from "../src/cli.ts";

/** 造一个可执行文件（PATH 探测用）。 */
function makeExecutable(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

/** 临时目录（测试结束不清理时由 OS 回收；仍显式登记便于真机排查）。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "herdr-use-cli-"));
}

test("readHerdrHandshake: 只有二进制必需；HERDR_* 全部可选且逐个收", () => {
  const dir = tempDir();
  const bin = makeExecutable(dir, "herdr");
  const full = readHerdrHandshake(
    {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "wT1:p1",
      HERDR_TAB_ID: "wT1:t1",
      HERDR_WORKSPACE_ID: "wT1",
      HERDR_BIN_PATH: bin,
    },
    undefined,
  );
  assert.deepEqual(full, {
    binPath: bin,
    socketPath: "/tmp/herdr.sock",
    callerPaneId: "wT1:p1",
    callerTabId: "wT1:t1",
    callerWorkspaceId: "wT1",
  });

  // 不在 herdr 内（无任何 HERDR_*）也能握手：dsh 可以跑在 tmux / 普通终端
  assert.deepEqual(readHerdrHandshake({ HERDR_BIN_PATH: bin }), {
    binPath: bin,
  });
  // 空串按未给；HERDR_ENV 不参与判定
  assert.deepEqual(
    readHerdrHandshake({
      HERDR_ENV: "0",
      HERDR_SOCKET_PATH: "",
      HERDR_PANE_ID: "",
      HERDR_TAB_ID: "",
      HERDR_WORKSPACE_ID: "",
      HERDR_BIN_PATH: bin,
    }),
    { binPath: bin },
  );
});

test("readHerdrHandshake: 二进制解析不到时返回 undefined（工具注册由上层拒）", () => {
  const emptyPath = tempDir();
  assert.equal(
    readHerdrHandshake(
      { HERDR_SOCKET_PATH: "/tmp/herdr.sock", PATH: emptyPath },
      undefined,
    ),
    undefined,
  );
  assert.equal(readHerdrHandshake({}, "/nonexistent/herdr"), undefined);
});

test("probeHerdrServerSync: server.status=running 即可达并带回 socket，其余为不可达", () => {
  const ok = probeHerdrServerSync("/fake/herdr", 100, () => ({
    stdout: JSON.stringify({
      server: { status: "running", socket: "/custom/herdr.sock" },
    }),
    stderr: "",
    status: 0,
  }));
  assert.deepEqual(ok, { ok: true, socketPath: "/custom/herdr.sock" });

  // 没有 socket 字段：可达但不给路径（由调用方回退平台缺省）
  assert.deepEqual(
    probeHerdrServerSync("/fake/herdr", 100, () => ({
      stdout: JSON.stringify({ server: { status: "running" } }),
      stderr: "",
      status: 0,
    })),
    { ok: true },
  );

  const stopped = probeHerdrServerSync("/fake/herdr", 100, () => ({
    stdout: JSON.stringify({ server: { status: "stopped" } }),
    stderr: "",
    status: 0,
  }));
  assert.equal(stopped.ok, false);
  assert.match(stopped.reason ?? "", /未运行/);

  const failed = probeHerdrServerSync("/fake/herdr", 100, () => ({
    stdout: "",
    stderr: "socket missing",
    status: 1,
  }));
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? "", /退出码 1/);
  assert.match(failed.reason ?? "", /socket missing/);

  const spawnFailed = probeHerdrServerSync("/fake/herdr", 100, () => ({
    stdout: "",
    stderr: "",
    status: null,
    error: "ENOENT",
  }));
  assert.equal(spawnFailed.ok, false);
  assert.match(spawnFailed.reason ?? "", /ENOENT/);

  const badJson = probeHerdrServerSync("/fake/herdr", 100, () => ({
    stdout: "server: running",
    stderr: "",
    status: 0,
  }));
  assert.equal(badJson.ok, false);
  assert.match(badJson.reason ?? "", /未运行/);
});

test("probeHerdrServerSync: 真起子进程（参数数组直通，status --json）", () => {
  const dir = tempDir();
  const bin = makeScript(
    dir,
    "herdr-status",
    'printf \'%s\' "$1" >/dev/null\nprintf \'{"server":{"status":"running","socket":"/s.sock"}}\'',
  );
  const probe = probeHerdrServerSync(bin, 2000);
  assert.deepEqual(probe, { ok: true, socketPath: "/s.sock" });
});

test("resolveHerdrBin: 显式路径优先，其次 HERDR_BIN_PATH，最后 PATH", () => {
  const dirA = tempDir();
  const dirB = tempDir();
  const explicit = makeExecutable(dirA, "herdr-explicit");
  const fromEnv = makeExecutable(dirB, "herdr-env");
  assert.equal(
    resolveHerdrBin(explicit, { HERDR_BIN_PATH: fromEnv, PATH: dirB }),
    explicit,
  );
  assert.equal(
    resolveHerdrBin(undefined, { HERDR_BIN_PATH: fromEnv, PATH: dirB }),
    fromEnv,
  );
  const viaPath = makeExecutable(dirA, "herdr");
  assert.equal(resolveHerdrBin(undefined, { PATH: dirA }), viaPath);
  assert.equal(resolveHerdrBin("/nonexistent/herdr", { PATH: dirB }), null);
});

test("findOnPath: 跳过空目录段，找不到返回 null", () => {
  const dir = tempDir();
  const bin = makeExecutable(dir, "herdr");
  assert.equal(findOnPath("herdr", `:${dir}:`), bin);
  assert.equal(findOnPath("herdr", tempDir()), null);
  // 空串 = 空 PATH（找不到）；显式 undefined 会走缺省参数（process.env.PATH），不在此断言
  assert.equal(findOnPath("herdr", ""), null);
  assert.equal(findOnPath("herdr", ":::"), null);
});

test("parseEnvelope: stdout 成功信封 / stderr 错误信封 / 纯文本 unparsed", () => {
  assert.deepEqual(parseEnvelope('{"id":"x","result":{"type":"ok"}}', ""), {
    kind: "ok",
    result: { type: "ok" },
  });
  assert.deepEqual(
    parseEnvelope(
      "",
      '{"error":{"code":"pane_not_found","message":"pane wT1:p999 not found"},"id":"cli:pane:get"}',
    ),
    {
      kind: "error",
      error: { code: "pane_not_found", message: "pane wT1:p999 not found" },
    },
  );
  assert.equal(parseEnvelope("", "unknown option: --nope").kind, "unparsed");
  // 错误信封写在 stdout 也认（不同子命令的写侧不统一）
  assert.equal(
    parseEnvelope('{"error":{"code":"timeout","message":"m"}}', "").kind,
    "error",
  );
  // 错误信封优先于成功信封（stdout 有噪声、stderr 才是真错）
  assert.equal(
    parseEnvelope(
      '{"result":{"type":"ok"}}',
      '{"error":{"code":"timeout","message":"m"}}',
    ).kind,
    "error",
  );
});

test("parseEnvelope: exit 0 且两侧皆空归一为成功空 result；非零退出 / 未知退出码仍 unparsed", () => {
  // 实测 pane send-text / send-keys / run 成功时不写任何回执（stdout 与 stderr 都空）
  assert.deepEqual(parseEnvelope("", "", 0), { kind: "ok", result: {} });
  assert.deepEqual(parseEnvelope(" \n\t", "", 0), { kind: "ok", result: {} });
  // 非零退出：空输出仍是失败（保持原语义）
  assert.equal(parseEnvelope("", "", 1).kind, "unparsed");
  assert.equal(parseEnvelope("", "", 2).kind, "unparsed");
  // 不知道退出码（socket 读通道）时不猜成功
  assert.equal(parseEnvelope("", "").kind, "unparsed");
  // 有输出但不是信封：不因 exit 0 而放行（由调用方按原文报错）
  assert.equal(parseEnvelope("warn: something", "", 0).kind, "unparsed");
  // 有 JSON 信封时行为不变
  assert.deepEqual(parseEnvelope('{"id":"x","result":{"type":"ok"}}', "", 0), {
    kind: "ok",
    result: { type: "ok" },
  });
  // 错误信封优先，即使 exit 0
  assert.equal(
    parseEnvelope("", '{"error":{"code":"x","message":"m"}}', 0).kind,
    "error",
  );
});

test("parseEnvelope: 带前后噪声仍能取第一个 JSON 对象", () => {
  const envelope = parseEnvelope(
    'warn: something\n{"id":"x","result":{"type":"pane_list"}}\ntrailing',
    "",
  );
  assert.equal(envelope.kind, "ok");
});

test("extractJsonObject: 无 JSON / 非法 JSON / 非对象均返回 null", () => {
  assert.equal(extractJsonObject(""), null);
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject("{broken"), null);
  assert.equal(extractJsonObject("[1,2]"), null);
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

test("classifyExit: 0 ok / 2 usage / 其余 error（含 -1 超时）", () => {
  assert.equal(classifyExit(0), "ok");
  assert.equal(classifyExit(2), "usage");
  assert.equal(classifyExit(1), "error");
  assert.equal(classifyExit(-1), "error");
});

test("commandLabel: 只为可读性拼命令，不含敏感参数值处理", () => {
  assert.equal(
    commandLabel(["pane", "list", "--workspace", "wT1"]),
    "herdr pane list --workspace wT1",
  );
});

test("临时目录可创建（守住 mkdtemp 假设，避免平台差异静默失败）", () => {
  const dir = tempDir();
  // mkdtemp 已建好目录，这里只验证其下可以正常落文件与子目录
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "file.txt"), "x");
  assert.equal(resolveHerdrBin(undefined, { PATH: dir }), null);
});

/** 造一个内容自定、可执行的 shell 脚本（子进程执行面测试用）。 */
function makeScript(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test("createDefaultRunner: 参数数组直通（不过 shell），stdout / 退出码原样带回", async () => {
  const dir = tempDir();
  // 逐行打印收到的每个 argv：若经过 shell 解释，"a b" 会被拆成两个参数
  const bin = makeScript(dir, "echo-args", 'printf "%s\\n" "$@"');
  const runner = createDefaultRunner(bin);
  const result = await runner.run(["pane", "a b", "$HOME"], 2000);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "pane\na b\n$HOME\n");
  assert.equal(result.stderr, "");
});

test("createDefaultRunner: 非零退出原样带回（exit 码与 stderr）", async () => {
  const dir = tempDir();
  const bin = makeScript(dir, "fail", 'echo "boom" >&2\nexit 3');
  const result = await createDefaultRunner(bin).run(["pane", "list"], 2000);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /boom/);
});

test("createDefaultRunner: 超时 SIGKILL 并返回 timedOut（不抛错）", async () => {
  const dir = tempDir();
  // exec：让 shell 自身被 sleep 取代，SIGKILL 直接落到 sleep 上（否则孙进程仍持管道）
  const bin = makeScript(dir, "hang", "exec sleep 5");
  const result = await createDefaultRunner(bin).run(["pane", "read"], 60);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /timeout: 60ms/);
});

test("createDefaultRunner: 二进制不存在 → spawn 失败归一（不抛错）", async () => {
  const dir = tempDir();
  const result = await createDefaultRunner(join(dir, "no-such-herdr")).run(
    ["pane", "list"],
    500,
  );
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /spawn 失败/);
});
