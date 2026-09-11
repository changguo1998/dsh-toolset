/**
 * 样例 1（搜索）：用 AST 模式在 TypeScript 文件中搜索 console.log 调用。
 *
 * 运行：npm --prefix ast-tools run example:search
 * 成功输出 SEARCH_EXAMPLE_PASS；失败以非零码退出。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchAst } from "../src/search.ts";

// 准备临时目标文件（2 行 console.log + 1 行 console.warn 干扰项）
const dir = mkdtempSync(join(tmpdir(), "ast-tools-search-"));
const file = join(dir, "sample.ts");
writeFileSync(
  file,
  [
    "import { helper } from './helper';",
    "function add(a: number, b: number) {",
    "  return a + b;",
    "}",
    "console.log(add(1, 2));",
    "console.warn('kept');",
    "",
  ].join("\n"),
);

try {
  // AST 模式搜索：$ARG 捕获参数单节点
  const matches = await searchAst({
    pattern: "console.log($ARG)",
    language: "ts",
    path: file,
  });
  assert.equal(matches.length, 1, "应恰好命中 1 处 console.log");
  assert.equal(matches[0]?.text, "console.log(add(1, 2))");
  assert.equal(matches[0]?.range.start.line, 4, "行号 0-based");
  assert.equal(
    matches[0]?.metaVariables?.single?.ARG?.text,
    "add(1, 2)",
    "元变量捕获",
  );
  // 输出命中（行号转为 1-based 展示）
  const hit = matches[0];
  console.log(
    `hit: ${hit.text} (L${(hit.range.start.line ?? 0) + 1}:${(hit.range.start.column ?? 0) + 1})`,
  );
  console.log("SEARCH_EXAMPLE_PASS");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
