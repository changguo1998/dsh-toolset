/**
 * 结构化替换正确性测试：元变量引用替换文本、多命中替换、
 * 长度变化时的偏移一致性、写回 vs 仅内存、无命中原样返回。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replaceAst } from "../src/replace.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

astTest("元变量引用替换文本 + 缺省不写回", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const original = "console.log('a');\nconst x = 1;\nconsole.log(x);\n";
    const file = writeFixture(dir, "a.ts", original);
    const result = await replaceAst({
      pattern: "console.log($MSG)",
      replacement: "console.info($MSG)",
      language: "ts",
      path: file,
    });
    assert.equal(result.replacedCount, 2);
    assert.equal(result.written, false);
    assert.equal(
      result.updatedSource,
      "console.info('a');\nconst x = 1;\nconsole.info(x);\n",
      "替换后全文逐字一致（非命中行不动）",
    );
    assert.equal(readFileSync(file, "utf8"), original, "磁盘未被改动");
  } finally {
    cleanup();
  }
});

astTest("多命中偏移一致性：替换长度变化时后续偏移不错位", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    // 第一处替换后文本变短，验证第二处仍精确命中
    const original = "foo(aaaaaaaa, bbbb);\nbar(1);\nfoo(cc, ddddd);\n";
    const file = writeFixture(dir, "a.ts", original);
    const result = await replaceAst({
      pattern: "foo($X, $Y)",
      replacement: "bar($X, $Y)",
      language: "ts",
      path: file,
    });
    assert.equal(result.replacedCount, 2);
    assert.equal(
      result.updatedSource,
      "bar(aaaaaaaa, bbbb);\nbar(1);\nbar(cc, ddddd);\n",
    );
  } finally {
    cleanup();
  }
});

astTest("write=true 写回磁盘", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.ts", "console.log(1);\n");
    const result = await replaceAst({
      pattern: "console.log($MSG)",
      replacement: "console.info($MSG)",
      language: "ts",
      path: file,
      write: true,
    });
    assert.equal(result.written, true);
    assert.equal(readFileSync(file, "utf8"), result.updatedSource);
    assert.equal(readFileSync(file, "utf8"), "console.info(1);\n");
  } finally {
    cleanup();
  }
});

astTest("多行结构替换：函数声明转箭头常量", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const original = "function add(a, b) {\n  return a + b;\n}\n";
    const file = writeFixture(dir, "a.ts", original);
    const result = await replaceAst({
      pattern: "function $NAME($$$ARGS) { $$$BODY }",
      replacement: "const $NAME = ($$$ARGS) => { $$$BODY }",
      language: "ts",
      path: file,
    });
    assert.equal(result.replacedCount, 1);
    assert.equal(
      result.updatedSource,
      "const add = (a, b) => { return a + b; }\n",
      "序列变量按原文展开",
    );
  } finally {
    cleanup();
  }
});

astTest("无命中：原样返回且替换数为 0", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const original = "console.warn(1);\n";
    const file = writeFixture(dir, "a.ts", original);
    const result = await replaceAst({
      pattern: "console.log($MSG)",
      replacement: "console.info($MSG)",
      language: "ts",
      path: file,
    });
    assert.equal(result.replacedCount, 0);
    assert.deepEqual(result.matches, []);
    assert.equal(result.updatedSource, original);
  } finally {
    cleanup();
  }
});
