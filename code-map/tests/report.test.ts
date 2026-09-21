/**
 * 报告测试：统计 / 模块聚合 / 依赖环 / 未引用导出文件。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodeMapSymbol } from "../src/types.ts";
import { CodeGraph } from "../src/graph/graph.ts";
import { buildReport } from "../src/report/builder.ts";

function sym(name: string, kind: string, file: string): CodeMapSymbol {
  return {
    id: `${file}::0:${name}`,
    name,
    kind,
    file,
    language: "typescript",
    startLine: 0,
    endLine: 2,
    signature: "",
    exported: true,
  };
}

/** 手工图：src 模块 3 文件（a 导出被 b import；d 导出无人引用）+ e/f 环。 */
function reportGraph(): CodeGraph {
  const g = new CodeGraph();
  g.addFile({
    path: "/r/src/a.ts",
    language: "typescript",
    symbols: [sym("Auth", "class", "/r/src/a.ts")],
  });
  g.addFile({
    path: "/r/src/b.ts",
    language: "typescript",
    symbols: [sym("use", "function", "/r/src/b.ts")],
  });
  g.addFile({
    path: "/r/src/c.ts",
    language: "typescript",
    symbols: [sym("read", "function", "/r/src/c.ts")],
  });
  g.addFile({
    path: "/r/src/d.ts",
    language: "typescript",
    symbols: [sym("orphan", "function", "/r/src/d.ts")],
  });
  g.addFile({ path: "/r/e.ts", language: "typescript", symbols: [] });
  g.addFile({ path: "/r/f.ts", language: "typescript", symbols: [] });
  g.addImport("/r/src/b.ts", "/r/src/a.ts");
  g.addImport("/r/e.ts", "/r/f.ts");
  g.addImport("/r/f.ts", "/r/e.ts");
  return g;
}

test("buildReport：统计 + 模块聚合 + 环 + 未引用导出", () => {
  const g = reportGraph();
  const r = buildReport("/r", g, 1);

  assert.equal(r.fileCount, 6);
  assert.equal(r.symbolCount, 4);
  assert.equal(r.importCount, 3); // b→a, e→f, f→e
  assert.equal(r.unresolvedImportCount, 1);
  assert.equal(r.languageCounts.typescript, 6);
  assert.equal(r.kindCounts.class, 1);
  assert.equal(r.kindCounts.function, 3);

  // 模块聚合
  const src = r.modules.find((m) => m.name === "src");
  assert.ok(src, "src 模块存在");
  assert.equal(src!.fileCount, 4);
  assert.equal(src!.symbolCount, 4);
  assert.deepEqual(src!.imports, []); // b→a 在 src 模块内，不算模块间
  const dot = r.modules.find((m) => m.name === ".");
  assert.ok(dot, "root 直接文件归 . 模块");
  assert.equal(dot!.fileCount, 2);

  // 依赖环：e/f
  assert.equal(r.moduleCycles.length, 1);
  assert.equal(r.moduleCycles[0]!.size, 2);

  // 未引用导出：b/c/d 有导出但无人 import（a 被 b import 除外）
  assert.deepEqual(r.unimportedExportFiles, [
    "/r/src/b.ts",
    "/r/src/c.ts",
    "/r/src/d.ts",
  ]);
});
