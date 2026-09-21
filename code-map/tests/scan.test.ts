/**
 * 结构层测试：收集 / 扫描 / import 解析。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { createAstToolsBundle } from "@dsh-toolset/ast-tools";
import {
  collectSourceFiles,
  resolveImport,
  scanProject,
} from "../src/indexer/scan.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

function commonFixture(): {
  dir: string;
  cleanup: () => void;
  root: string;
} {
  const { dir, cleanup } = withTempDir();
  const root = join(dir, "repo");
  writeFixture(
    root,
    "src/a.ts",
    [
      "// a.ts — 被引用目标",
      "export class Auth {",
      "  authenticate(user: string): string {",
      "    return user;",
      "  }",
      "}",
      "export function helper(): number {",
      "  return 42;",
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
      "  return a.authenticate('x');",
      "}",
    ].join("\n"),
  );
  writeFixture(
    root,
    "src/c.ts",
    [
      "import * as fs from 'node:fs';",
      "export function read(p: string): string {",
      "  return fs.readFileSync(p, 'utf8');",
      "}",
    ].join("\n"),
  );
  return { dir, cleanup, root };
}

test("collectSourceFiles：只收集源码扩展名，排除 node_modules/隐藏目录", () => {
  const { dir, cleanup, root } = commonFixture();
  try {
    writeFixture(root, "node_modules/x/y.ts", "export const yy = 1;");
    writeFixture(root, "src/ignored.js", "export const jj = 1;");
    writeFixture(root, "notes.txt", "not source");
    const files = collectSourceFiles(root);
    const rel = files.map((f) => resolve(f).replace(resolve(root) + "/", ""));
    assert.ok(rel.includes("src/a.ts"));
    assert.ok(rel.includes("src/b.ts"));
    assert.ok(rel.includes("src/c.ts"));
    assert.ok(rel.includes("src/ignored.js"));
    assert.ok(
      !rel.some((r) => r.startsWith("node_modules/")),
      "跳过 node_modules",
    );
    assert.ok(!rel.some((r) => r.endsWith(".txt")));
  } finally {
    cleanup();
    void dir;
  }
});

test("resolveImport：相对补扩展名 / 目录 index / 外部 null", () => {
  const { dir, cleanup, root } = commonFixture();
  try {
    const fromB = resolve(root, "src/b.ts");
    assert.equal(resolveImport("./a", fromB, root), resolve(root, "src/a.ts"));
    // 有扩展名直接命中
    assert.equal(
      resolveImport("./a.ts", fromB, root),
      resolve(root, "src/a.ts"),
    );
    // 外部/内置
    assert.equal(resolveImport("node:fs", fromB, root), null);
    assert.equal(resolveImport("@scope/lib", fromB, root), null);
    // 不存在
    assert.equal(resolveImport("./missing", fromB, root), null);
  } finally {
    cleanup();
    void dir;
  }
});

astTest(
  "scanProject：符号表 + import 边（外部 import 记为 to=null）",
  async () => {
    const { dir, cleanup, root } = commonFixture();
    try {
      const ast = createAstToolsBundle();
      const scan = await scanProject(ast, root);
      assert.equal(scan.filesScanned, 3); // a/b/c
      const byRel = new Map(
        scan.files.map((f) => [f.path.replace(resolve(root) + "/", ""), f]),
      );
      const a = byRel.get("src/a.ts");
      assert.ok(a, "a.ts 被扫描");
      const names = (a?.symbols ?? []).map((s) => `${s.kind}:${s.name}`);
      // ast-grep outline 的 astKind 是语法节点名（export_statement / method_definition 等），
      // 符号身份以 name 为准，kind 只做弱断言
      assert.ok(
        (a?.symbols ?? []).some((s) => s.name === "Auth"),
        `有 Auth 符号（实际 ${names}）`,
      );
      assert.ok(
        a?.symbols.some((s) => s.name === "authenticate"),
        `有 authenticate 方法（实际 ${names}）`,
      );
      assert.ok(
        (a?.symbols ?? []).some((s) => s.kind.toLowerCase().includes("export")),
        `Auth 的 kind 含 export（实际 ${names}）`,
      );
      const b = byRel.get("src/b.ts");
      assert.ok(b && b.symbols.some((s) => s.name === "use"));
      // import 边
      const importBtoA = scan.imports.find(
        (i) =>
          i.from === resolve(root, "src/b.ts") &&
          i.to === resolve(root, "src/a.ts"),
      );
      assert.ok(importBtoA, "b → a 已解析");
      const importC = scan.imports.find(
        (i) => i.from === resolve(root, "src/c.ts"),
      );
      assert.equal(importC?.to, null, "node:fs 外部 import to=null");
    } finally {
      cleanup();
      void dir;
    }
  },
);
