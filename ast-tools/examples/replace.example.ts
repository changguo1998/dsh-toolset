/**
 * 样例 2（替换）：把 TypeScript 文件里的 console.log 结构化替换为 console.info。
 *
 * 运行：npm --prefix ast-tools run example:replace
 * 成功输出 REPLACE_EXAMPLE_PASS；失败以非零码退出。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceAst } from "../src/replace.ts";

// 准备临时目标文件（2 处 console.log + 1 处不应触碰的 console.warn）
const dir = mkdtempSync(join(tmpdir(), "ast-tools-replace-"));
const file = join(dir, "sample.ts");
const original = [
  "console.log('before');",
  "const x = 1;",
  "console.log(x);",
  "console.warn('untouched');",
  "",
].join("\n");
writeFileSync(file, original);

try {
  // 结构化替换：$MSG 引用捕获的实参（CLI fix 语义），不写回磁盘
  const result = await replaceAst({
    pattern: "console.log($MSG)",
    replacement: "console.info($MSG)",
    language: "ts",
    path: file,
  });
  assert.equal(result.replacedCount, 2, "应替换 2 处");
  assert.equal(result.written, false, "缺省不写回");
  const expected = [
    "console.info('before');",
    "const x = 1;",
    "console.info(x);",
    "console.warn('untouched');",
    "",
  ].join("\n");
  assert.equal(result.updatedSource, expected, "替换后全文逐字一致");
  assert.equal(readFileSync(file, "utf8"), original, "磁盘文件未被改动");
  // 展示替换前后 diff 摘要
  console.log(`replaced ${result.replacedCount} occurrence(s):`);
  for (const line of result.updatedSource.split("\n")) {
    if (line.includes("console.info")) console.log(`  + ${line}`);
  }
  console.log("REPLACE_EXAMPLE_PASS");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
