/**
 * 二进制探测与降级行为测试：
 * - 降级报错含全部安装路径（无需二进制，恒跑）；
 * - 显式 bin 参数无效时探测失败（无需二进制，恒跑）；
 * - AST_GREP_BIN 环境变量覆盖 / 真实探测 / 错误参数路径（需二进制，条件跑）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AstGrepMissingError,
  AstGrepProcessError,
  findAstGrepBin,
  INSTALL_GUIDANCE,
  ensureAstGrepBin,
} from "../src/binary.ts";
import { runCliJson } from "../src/binary.ts";
import { hasAstGrep } from "./helpers.ts";

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
