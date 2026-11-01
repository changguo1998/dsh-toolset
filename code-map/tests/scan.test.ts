/**
 * 结构层测试：收集 / 扫描 / import 解析。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import type { AstToolsBundle } from "@dsh-toolset/ast-tools";
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

test("resolveImport：绝对说明符按仓库内/外分流", () => {
  const { dir, cleanup, root } = commonFixture();
  try {
    const fromB = resolve(root, "src/b.ts");
    const inside = resolve(root, "src/a.ts");
    assert.equal(
      resolveImport(inside, fromB, root),
      inside,
      "仓库内绝对路径命中",
    );
    const outside = writeFixture(dir, "outside/o.ts", "export const o = 1;\n");
    assert.equal(
      resolveImport(outside, fromB, root),
      null,
      "仓库外绝对路径拒绝",
    );
    // 带引号的说明符去引号后再解析
    assert.equal(resolveImport("'./a'", fromB, root), inside);
  } finally {
    cleanup();
    void dir;
  }
});

test("collectSourceFiles：噪音目录（dist/tmp/archive/coverage/.git）一律跳过", () => {
  const { dir, cleanup, root } = commonFixture();
  try {
    for (const noise of [
      "dist/x.ts",
      "tmp/y.ts",
      "archive/z.ts",
      "coverage/c.ts",
      ".git/g.ts",
    ]) {
      writeFixture(root, noise, "export const n = 1;\n");
    }
    const files = collectSourceFiles(root);
    const rel = files.map((f) => resolve(f).replace(resolve(root) + "/", ""));
    assert.ok(rel.includes("src/a.ts"));
    for (const skipped of ["dist", "tmp", "archive", "coverage", ".git"]) {
      assert.ok(
        !rel.some((r) => r.startsWith(`${skipped}/`)),
        `跳过 ${skipped}`,
      );
    }
  } finally {
    cleanup();
    void dir;
  }
});

test("scanProject：outline 抛错或返回空数组的文件被跳过，filesScanned 仍逐个计数", async () => {
  const { dir, cleanup } = withTempDir();
  const root = join(dir, "repo");
  writeFixture(root, "ok.ts", "export const ok = 1;\n");
  writeFixture(root, "broken.ts", "???\n");
  writeFixture(root, "empty.ts", "\n");
  try {
    const stub = {
      async outline(params: { path: string }) {
        if (params.path.endsWith("broken.ts")) {
          throw new Error("ast-grep: 解析失败");
        }
        if (params.path.endsWith("empty.ts")) return [];
        return [
          {
            path: params.path,
            language: "typescript",
            items: [
              {
                role: "item",
                symbolType: "variable",
                name: "ok",
                range: {
                  start: { line: 0, column: 0 },
                  end: { line: 0, column: 20 },
                  byteOffset: { start: 0, end: 0 },
                },
                signature: "export const ok = 1",
                astKind: "lexical_declaration",
                isImport: false,
                isExported: true,
              },
            ],
          },
        ];
      },
    } as unknown as AstToolsBundle;
    const scan = await scanProject(stub, root);
    assert.equal(scan.filesScanned, 3, "收集到的文件都计数");
    assert.equal(scan.files.length, 1, "只有 outline 成功的文件进图");
    assert.equal(scan.files[0]?.path, resolve(root, "ok.ts"));
    assert.deepEqual(
      scan.files[0]?.symbols.map((s) => s.name),
      ["ok"],
    );
    assert.deepEqual(scan.imports, []);
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
