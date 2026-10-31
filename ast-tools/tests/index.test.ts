/**
 * 入口与核心工厂测试（src/index.ts）：
 * - `createAstToolsBundle` 绑定二进制与四个操作、缺二进制抛 MissingError；
 * - `dispose` 无持久资源（幂等、不抛）；
 * - `apply` 在无工具面 / 无服务面的极简宿主上不崩（降级与降级注册）；
 * 不依赖真实 ast-grep 调用（配置指向任意可执行文件，操作为惰性绑定）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AstGrepMissingError,
  apply,
  createAstToolsBundle,
  toToolDefs,
  unavailableOps,
} from "../src/index.ts";

test("createAstToolsBundle: 绑定二进制与四个操作，dispose 幂等", () => {
  const bundle = createAstToolsBundle({
    bin: process.execPath,
    timeoutMs: 1_234,
  });
  assert.equal(bundle.bin, process.execPath);
  for (const method of ["search", "replace", "outline", "rules"] as const) {
    assert.equal(typeof bundle[method], "function", method);
  }
  bundle.dispose();
  bundle.dispose();
});

test("createAstToolsBundle: 二进制缺失抛 AstGrepMissingError", () => {
  assert.throws(
    () => createAstToolsBundle({ bin: "/nonexistent/ast-grep-xyz" }),
    AstGrepMissingError,
  );
});

test("createAstToolsBundle: 缺省配置走默认探测（本机有二进制时命中）", () => {
  try {
    const bundle = createAstToolsBundle();
    assert.ok(bundle.bin.length > 0);
  } catch (error) {
    // 本机无 ast-grep 的机器上如实走缺省降级路径
    assert.ok(error instanceof AstGrepMissingError);
  }
});

test("apply: 无 tools 面时不抛，仍记 ready 日志", () => {
  const logs: string[] = [];
  apply(
    { logger: () => ({ info: (message: string) => logs.push(message) }) },
    { bin: process.execPath },
  );
  assert.ok(logs.some((line) => line.includes("ast-tools ready")));
});

test("apply: 无 tools 面时降级也不抛（只记降级日志）", () => {
  const logs: string[] = [];
  apply(
    { logger: () => ({ info: (message: string) => logs.push(message) }) },
    { bin: "/nonexistent/ast-grep-xyz" },
  );
  assert.ok(logs.some((line) => line.includes("降级")));
});

test("apply: 非 MissingError 的装配错误向上抛", () => {
  // bin 指向目录 → findAstGrepBin 视为不可执行 → MissingError；这里用抛错的 tools 面
  // 触发注册期异常，验证 apply 不吞掉非降级错误。
  assert.throws(
    () =>
      apply(
        {
          logger: () => ({ info: () => {} }),
          tools: {
            register: () => {
              throw new Error("注册面异常");
            },
          },
        },
        { bin: process.execPath },
      ),
    /注册面异常/,
  );
});

test("toToolDefs: 降级替身也产出两个具名工具", () => {
  const defs = toToolDefs(unavailableOps("x")) as Array<{ name: string }>;
  assert.deepEqual(
    defs.map((def) => def.name),
    ["ast_query", "ast_replace"],
  );
});
