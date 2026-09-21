/**
 * 图与查询测试：内存图（import 双向索引 / SCC）+ callers/impact/callees。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  createAstToolsBundle,
  type AstToolsBundle,
} from "@dsh-toolset/ast-tools";
import { scanProject } from "../src/indexer/scan.ts";
import { CodeGraph } from "../src/graph/graph.ts";
import { callers, calleesFiles, impact } from "../src/graph/query.ts";
import { candidateRefs } from "../src/indexer/refs.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

/** 手工构造图（无 ast-grep 依赖，纯图算法）。 */
function manualGraph(): CodeGraph {
  const g = new CodeGraph();
  g.addFile({ path: "/r/a.ts", language: "typescript", symbols: [] });
  g.addFile({ path: "/r/b.ts", language: "typescript", symbols: [] });
  g.addFile({ path: "/r/c.ts", language: "typescript", symbols: [] });
  g.addFile({ path: "/r/e.ts", language: "typescript", symbols: [] });
  g.addFile({ path: "/r/f.ts", language: "typescript", symbols: [] });
  g.addImport("/r/b.ts", "/r/a.ts"); // b 依赖 a
  g.addImport("/r/c.ts", "/r/b.ts"); // c 依赖 b
  g.addImport("/r/e.ts", "/r/f.ts");
  g.addImport("/r/f.ts", "/r/e.ts");
  return g;
}

test("transitiveDependents：反向传递闭包（b 依赖 a、c 依赖 b → a 的依赖集 = {b,c}）", () => {
  const g = manualGraph();
  assert.deepEqual(g.transitiveDependents("/r/a.ts"), ["/r/b.ts", "/r/c.ts"]);
  assert.deepEqual(g.transitiveDependents("/r/b.ts"), ["/r/c.ts"]);
  assert.deepEqual(g.transitiveDependents("/r/c.ts"), []);
});

test("sccCycles：只有 e/f 环（size=2）被检出", () => {
  const g = manualGraph();
  const cycles = g.sccCycles();
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0]?.size, 2);
  assert.deepEqual(
    new Set(cycles[0]!.members),
    new Set(["/r/e.ts", "/r/f.ts"]),
  );
});

test("calleesFiles / impact：文件级依赖与反向闭包聚合", () => {
  const g = manualGraph();
  const sym = {
    id: "r::0:X",
    name: "X",
    kind: "function",
    file: "/r/a.ts",
    language: "typescript",
    startLine: 0,
    endLine: 2,
    signature: "",
    exported: true,
  };
  const symB = {
    ...sym,
    name: "Y",
    file: "/r/b.ts",
    id: "r::1:Y",
    startLine: 3,
  };
  assert.deepEqual(calleesFiles(g, symB), ["/r/a.ts"]); // b 依赖 a
  const imp = impact(g, "/r", "/r/a.ts");
  assert.deepEqual(imp.files, ["/r/b.ts", "/r/c.ts"]);
  assert.deepEqual(imp.modules, ["."]); // root 下直接文件归 "."
});

astTest("scan 后 callers：候选引用排除定义行", async () => {
  const { dir, cleanup } = withTempDir();
  const root = join(dir, "repo");
  writeFixture(
    root,
    "src/a.ts",
    [
      "export class Auth {",
      "  authenticate(user: string): string {",
      "    return user;",
      "  }",
      "}",
    ].join("\n"),
  );
  writeFixture(
    root,
    "src/b.ts",
    [
      "import { Auth } from './a';",
      "export function use(): string {",
      "  const a = new Auth();",
      "  const x = new Auth();",
      "  return a.authenticate('x') + x.authenticate('y');",
      "}",
    ].join("\n"),
  );
  try {
    const ast: AstToolsBundle = createAstToolsBundle();
    const scan = await scanProject(ast, root);
    const g = new CodeGraph();
    for (const f of scan.files) g.addFile(f);
    for (const im of scan.imports) if (im.to) g.addImport(im.from, im.to);
    const aFile = resolve(root, "src/a.ts");
    const authSym = scan.files
      .find((f) => f.path === aFile)!
      .symbols.find((s) => s.name === "Auth")!;
    const r = await callers(g, authSym, {
      refsOf: (s) => candidateRefs(ast, root, s),
    });
    // 引用出现在 b.ts（import + new Auth + new Auth）
    assert.ok(
      r.files.includes(resolve(root, "src/b.ts")),
      `引用文件含 b.ts（实际 ${r.files}）`,
    );
    // 定义行被排除：a.ts 不应出现在候选里（a.ts 内无其他 Auth 使用）
    assert.ok(!r.files.includes(aFile), `定义文件被排除（实际 ${r.files}）`);
    assert.ok(r.refs.length >= 2, `至少两条引用候选（实际 ${r.refs.length}）`);
    for (const ref of r.refs) {
      assert.ok(
        !(
          ref.file === aFile &&
          ref.line >= authSym.startLine &&
          ref.line <= authSym.endLine
        ),
        "无定义行引用",
      );
    }
  } finally {
    cleanup();
    void dir;
  }
});
