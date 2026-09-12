/**
 * 大纲结构测试：TS import/export/函数/类与成员、Python 类方法嵌套、
 * 类型过滤、items 选项（默认 structure 不含 import，all 含 import）。
 */

import assert from "node:assert/strict";
import { outlineFile } from "../src/outline.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

const TS_FIXTURE = [
  'import { helper } from "./helper";',
  "export function add(a: number, b: number) { return a + b; }",
  "class Foo { m() { return 1; } }",
  "",
].join("\n");

astTest("TypeScript：顶层项 + 类成员 + 0-based 范围", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.ts", TS_FIXTURE);
    const files = await outlineFile({ path: file });
    assert.equal(files.length, 1);
    const entry = files[0];
    assert.equal(entry?.language, "TypeScript");
    // 默认 items=auto → structure：2 个顶层项（函数 + 类），import 不在其中
    assert.equal(entry?.items.length, 2);
    const fn = entry?.items.find((i) => i.symbolType === "function");
    assert.ok(fn, "含 function 项");
    assert.equal(fn?.name, "add");
    assert.equal(fn?.isExported, true);
    assert.equal(fn?.range.start.line, 1, "行号 0-based（第 2 行）");
    assert.ok(fn?.signature.includes("function add"));
    const cls = entry?.items.find((i) => i.symbolType === "class");
    assert.ok(cls, "含 class 项");
    assert.equal(cls?.name, "Foo");
    assert.equal(cls?.astKind, "class_declaration");
    // 类成员（方法）
    const member = cls?.members?.find((m) => m.symbolType === "method");
    assert.ok(member, "类含 method 成员");
    assert.equal(member?.name, "m");
    assert.equal(member?.role, "member");
  } finally {
    cleanup();
  }
});

astTest("items=all：import 项出现且 isImport=true", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.ts", TS_FIXTURE);
    const files = await outlineFile({ path: file, items: "all" });
    const items = files[0]?.items ?? [];
    const imp = items.find((i) => i.isImport);
    assert.ok(imp, "items=all 时含 import 项");
    assert.equal(imp?.astKind, "import_statement");
    assert.ok(imp?.signature.includes("import { helper }"));
  } finally {
    cleanup();
  }
});

astTest("Python：类 + 方法嵌套", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(
      dir,
      "a.py",
      "class Widget:\n    def render(self):\n        return '<div>'\n",
    );
    const files = await outlineFile({ path: file });
    const cls = files[0]?.items.find((i) => i.symbolType === "class");
    assert.ok(cls, "含 class 项");
    assert.equal(cls?.name, "Widget");
    assert.equal(cls?.members?.length, 1);
    assert.equal(cls?.members?.[0]?.symbolType, "method");
    assert.equal(cls?.members?.[0]?.name, "render");
  } finally {
    cleanup();
  }
});

astTest("类型过滤：types=['class'] 仅保留类项", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.ts", TS_FIXTURE);
    const files = await outlineFile({ path: file, types: ["class"] });
    const items = files[0]?.items ?? [];
    assert.ok(items.length >= 1, "至少保留 class 项");
    assert.ok(
      items.every((i) => i.symbolType === "class"),
      "过滤后仅剩 class 项",
    );
  } finally {
    cleanup();
  }
});
