/**
 * 二进制探测与降级行为测试：
 * - 降级报错含全部安装路径（无需二进制，恒跑）；
 * - 显式 bin 参数无效时探测失败（无需二进制，恒跑）；
 * - AST_GREP_BIN 环境变量覆盖 / 真实探测 / 错误参数路径（需二进制，条件跑）。
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  AstGrepError,
  AstGrepJsonError,
  AstGrepMissingError,
  AstGrepProcessError,
  findAstGrepBin,
  INSTALL_GUIDANCE,
  ensureAstGrepBin,
  parseJsonArray,
  runCli,
} from "../src/binary.ts";
import { runCliJson } from "../src/binary.ts";
import { hasAstGrep } from "./helpers.ts";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 建临时目录与可执行脚本夹具。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ast-tools-binary-"));
  tempDirs.push(dir);
  return dir;
}
function makeScript(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

// ---- 无需二进制的用例（恒跑）----

test("降级报错信息包含全部安装路径", () => {
  const paths = [
    "npm install -g @ast-grep/cli",
    "brew install ast-grep",
    "cargo install ast-grep",
    "https://github.com/ast-grep/ast-grep/releases",
    "AST_GREP_BIN",
  ];
  for (const snippet of paths) {
    assert.ok(INSTALL_GUIDANCE.includes(snippet), `安装指引应包含：${snippet}`);
  }
});

test("二进制缺失：ensureAstGrepBin 抛 AstGrepMissingError 且含安装路径", () => {
  assert.throws(
    () => ensureAstGrepBin("/nonexistent/ast-grep-xyz"),
    (error: unknown) => {
      assert.ok(error instanceof AstGrepMissingError, "错误类型");
      const message = (error as Error).message;
      assert.ok(
        message.includes("npm install -g @ast-grep/cli"),
        "npm 安装路径",
      );
      assert.ok(message.includes("brew install ast-grep"), "brew 安装路径");
      assert.ok(message.includes("cargo install ast-grep"), "cargo 安装路径");
      assert.ok(
        message.includes("github.com/ast-grep/ast-grep/releases"),
        "releases 下载路径",
      );
      return true;
    },
  );
});

test("二进制缺失：findAstGrepBin 返回 null 而不抛错", () => {
  assert.equal(findAstGrepBin("/nonexistent/ast-grep-xyz"), null);
});

test("二进制缺失：runCliJson 抛 AstGrepMissingError", async () => {
  await assert.rejects(
    runCliJson(["run", "-p", "x", "-l", "ts"], {
      bin: "/nonexistent/ast-grep-xyz",
    }),
    AstGrepMissingError,
  );
});

test("parseJsonArray: 空输出视为无命中，带前后噪音时取数组片段", () => {
  assert.deepEqual(parseJsonArray("run", ""), []);
  assert.deepEqual(parseJsonArray("run", "  \n\t "), []);
  assert.deepEqual(parseJsonArray("run", "[1,2]"), [1, 2]);
  // 前后混有日志行时取首尾括号之间的片段（ast-grep 承诺纯 JSON，此处为防御）
  assert.deepEqual(parseJsonArray("run", "warn x\n[1,2]\nwarn y"), [1, 2]);
  // 输出里根本没有 JSON 数组（如单个对象）时按解析失败处理，不做「包成单元素」
  assert.throws(() => parseJsonArray("run", '{"a":1}'), AstGrepJsonError);
});

test("parseJsonArray: 无数组或 JSON 非法抛 AstGrepJsonError 并带输出片段", () => {
  assert.throws(
    () => parseJsonArray("scan --json", "no array here"),
    (error: unknown) => {
      assert.ok(error instanceof AstGrepJsonError, "错误类型");
      assert.match((error as Error).message, /JSON 输出解析失败/);
      assert.match((error as Error).message, /no array here/);
      return true;
    },
  );
  assert.throws(
    () => parseJsonArray("scan --json", "[1,"),
    AstGrepJsonError,
    "未闭合数组按解析失败处理",
  );
  assert.throws(
    () => parseJsonArray("scan --json", "[{bad}]"),
    (error: unknown) => {
      assert.ok(error instanceof AstGrepJsonError);
      assert.match(String((error as Error).cause), /SyntaxError/);
      return true;
    },
  );
});

test("findAstGrepBin: 显式 bin 不可执行时按未找到处理", () => {
  const dir = tempDir();
  const file = join(dir, "not-executable");
  writeFileSync(file, "#!/bin/sh\n", "utf8");
  chmodSync(file, 0o644);
  assert.equal(findAstGrepBin(file), null);
});

test("findAstGrepBin: AST_GREP_BIN 不可用时继续按 PATH 探测", () => {
  const prev = process.env.AST_GREP_BIN;
  try {
    delete process.env.AST_GREP_BIN;
    const expected = findAstGrepBin();
    process.env.AST_GREP_BIN = "/nonexistent/ast-grep-env";
    assert.equal(findAstGrepBin(), expected, "无效环境变量不短路探测");
  } finally {
    if (prev === undefined) delete process.env.AST_GREP_BIN;
    else process.env.AST_GREP_BIN = prev;
  }
});

test("findAstGrepBin: PATH 无命中时回落本地 node_modules/.bin", () => {
  const prev = process.env.PATH;
  process.env.PATH = "";
  try {
    const found = findAstGrepBin();
    assert.ok(
      found === null ||
        found.endsWith(join("node_modules", ".bin", "ast-grep")),
      `回落路径应是本地 node_modules/.bin，实际：${String(found)}`,
    );
  } finally {
    process.env.PATH = prev;
  }
});

test("runCli: 二进制不可启动时抛启动失败（非 MissingError）", async () => {
  await assert.rejects(
    runCli("/nonexistent/ast-grep-start", [], 1_000),
    (error: unknown) => {
      assert.ok(error instanceof AstGrepError);
      assert.ok(
        !(error instanceof AstGrepMissingError),
        "是 spawn 失败而非探测失败",
      );
      assert.match((error as Error).message, /ast-grep 启动失败/);
      return true;
    },
  );
});

test("runCli: 收集 stdout / stderr 与退出码", async () => {
  const dir = tempDir();
  const bin = makeScript(dir, "echo", "echo hi; echo oops >&2; exit 3");
  assert.deepEqual(await runCli(bin, [], 5_000), {
    stdout: "hi\n",
    stderr: "oops\n",
    exitCode: 3,
  });
});

test("runCli: 未注入 deadline 时用进程内超时，到点 SIGKILL", async () => {
  const dir = tempDir();
  const bin = makeScript(dir, "hang", "exec sleep 5");
  const result = await runCli(bin, [], 30);
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /timeout: 30ms/);
});

test("runCliJson: 无 JSON 时零退出给空数组，非零退出抛 ProcessError", async () => {
  const dir = tempDir();
  const ok = makeScript(dir, "ok", "exit 0");
  assert.deepEqual(await runCliJson(["run"], { bin: ok }), []);

  const fail = makeScript(dir, "fail", "echo boom >&2; exit 2");
  await assert.rejects(runCliJson(["run"], { bin: fail }), (error: unknown) => {
    assert.ok(error instanceof AstGrepProcessError);
    assert.equal((error as AstGrepProcessError).exitCode, 2);
    assert.match((error as AstGrepProcessError).stderr, /boom/);
    assert.match((error as Error).message, /exit=2/);
    return true;
  });

  const silent = makeScript(dir, "silent", "exit 4");
  await assert.rejects(
    runCliJson(["run"], { bin: silent }),
    (error: unknown) => {
      assert.ok(error instanceof AstGrepProcessError);
      assert.match((error as Error).message, /无 stderr 输出/);
      return true;
    },
  );
});

test("runCliJson: 有 JSON 输出时忽略非零退出码", async () => {
  const dir = tempDir();
  const bin = makeScript(
    dir,
    "json-exit-1",
    'printf "[{\\"text\\":\\"x\\"}]"; exit 1',
  );
  assert.deepEqual(await runCliJson(["run", "-p", "x"], { bin }), [
    { text: "x" },
  ]);
});

// ---- 需要二进制的用例（条件跑）----

const binTest = hasAstGrep() ? test : test.skip;

binTest("AST_GREP_BIN 环境变量覆盖探测", () => {
  const found = findAstGrepBin();
  assert.ok(found, "前置：当前环境应能探测到二进制");
  const prev = process.env.AST_GREP_BIN;
  process.env.AST_GREP_BIN = found;
  try {
    assert.equal(findAstGrepBin(), found, "环境变量优先于 PATH");
  } finally {
    if (prev === undefined) delete process.env.AST_GREP_BIN;
    else process.env.AST_GREP_BIN = prev;
  }
});

binTest("默认探测命中可用二进制", () => {
  const found = findAstGrepBin();
  assert.ok(found, "应探测到 ast-grep 或 sg");
});

binTest("错误参数：无效语言抛 AstGrepProcessError 且含 stderr", async () => {
  await assert.rejects(
    runCliJson([
      "run",
      "-p",
      "f()",
      "-l",
      "not-a-language",
      "--json=compact",
      "/dev/null",
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AstGrepProcessError, "错误类型");
      assert.ok(
        (error as AstGrepProcessError).stderr.length > 0,
        "应携带 CLI stderr",
      );
      return true;
    },
  );
});
