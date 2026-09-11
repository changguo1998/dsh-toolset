/**
 * 多语言模式匹配测试：TypeScript / Python / Go 命中、元变量捕获、
 * 0-based 坐标、无命中空结果、结构性精确匹配（无文本误报）。
 */

import assert from "node:assert/strict";
import { searchAst } from "../src/search.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

astTest("TypeScript：方法调用模式 + 单节点元变量捕获", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(
      dir,
      "a.ts",
      "console.log(add(1, 2));\nconsole.warn('x');\n",
    );
    const matches = await searchAst({
      pattern: "console.log($ARG)",
      language: "ts",
      path: file,
    });
    assert.equal(matches.length, 1, "console.log 恰好命中 1 处");
    assert.equal(matches[0]?.text, "console.log(add(1, 2))");
    assert.equal(matches[0]?.range.start.line, 0, "行号 0-based");
    assert.equal(matches[0]?.range.start.column, 0);
    assert.equal(matches[0]?.metaVariables?.single?.ARG?.text, "add(1, 2)");
  } finally {
    cleanup();
  }
});

astTest("TypeScript：函数声明模式 + 序列元变量捕获", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(
      dir,
      "b.ts",
      "function add(a, b) {\n  return a + b;\n}\nconst noop = () => {};\n",
    );
    const matches = await searchAst({
      pattern: "function $NAME($$$ARGS) { $$$BODY }",
      language: "ts",
      path: file,
    });
    assert.equal(matches.length, 1, "箭头函数不匹配 function 声明");
    assert.equal(matches[0]?.metaVariables?.single?.NAME?.text, "add");
    // 序列捕获含参数与分隔符节点：a , b
    const args = matches[0]?.metaVariables?.multi?.ARGS?.map((v) => v.text);
    assert.deepEqual(args, ["a", ",", "b"]);
  } finally {
    cleanup();
  }
});

astTest("Python：def 模式多命中", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(
      dir,
      "a.py",
      "def greet(name):\n    print(f'hi {name}')\n\ndef bye():\n    return None\n",
    );
    const matches = await searchAst({
      pattern: "def $NAME($$$ARGS): $$$BODY",
      language: "py",
      path: file,
    });
    assert.equal(matches.length, 2);
    const names = matches
      .map((m) => m.metaVariables?.single?.NAME?.text)
      .sort();
    assert.deepEqual(names, ["bye", "greet"]);
  } finally {
    cleanup();
  }
});

astTest("Go：函数声明模式", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(
      dir,
      "a.go",
      'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n',
    );
    const matches = await searchAst({
      pattern: "func $NAME($$$ARGS) { $$$BODY }",
      language: "go",
      path: file,
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.metaVariables?.single?.NAME?.text, "main");
  } finally {
    cleanup();
  }
});

astTest("无命中：返回空数组且不抛错", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.ts", "console.warn('x');\n");
    const matches = await searchAst({
      pattern: "alert($X)",
      language: "ts",
      path: file,
    });
    assert.deepEqual(matches, []);
  } finally {
    cleanup();
  }
});

astTest("结构性精确匹配：参数个数不符不命中", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "a.ts", "console.log(a, b);\n");
    const single = await searchAst({
      pattern: "console.log($ARG)",
      language: "ts",
      path: file,
    });
    assert.equal(single.length, 0, "$ARG 单节点不能匹配两个实参");
    const multi = await searchAst({
      pattern: "console.log($$$ARGS)",
      language: "ts",
      path: file,
    });
    assert.equal(multi.length, 1, "$$$ARGS 序列可匹配两个实参");
  } finally {
    cleanup();
  }
});
