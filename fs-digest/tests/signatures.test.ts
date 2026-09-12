// tests/signatures.test.ts — signatures 启发式（TS/Python）与 LSP 来源
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSignatures,
  extractPythonSignatures,
  extractTsSignatures,
} from "../src/signatures.ts";

const tsText = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export const multiply = (x: number, y: number): number => x * y;",
  "",
  "export async function fetchPayload(",
  "  id: number,",
  "  options: { retry?: number; timeoutMs?: number },",
  "  signal?: AbortSignal,",
  "): Promise<{ id: number }> {",
  "  return { id };",
  "}",
  "",
  "export class Counter {",
  "  constructor(private step: number) {}",
  "  increment(): number {",
  "    return 1;",
  "  }",
  "  static from(value: number): Counter {",
  "    return new Counter(value);",
  "  }",
  "}",
  "",
].join("\n");

describe("TS/JS 启发式签名", () => {
  it("函数声明 / 箭头函数 / 多行折叠 / 类方法", () => {
    const sigs = extractTsSignatures(tsText);
    assert.equal(sigs.length, 6);
    assert.deepEqual(
      sigs.map((s) => `${s.kind}:${s.name}`),
      [
        "function:add",
        "function:multiply",
        "function:fetchPayload",
        "constructor:constructor",
        "method:increment",
        "method:from",
      ],
    );
    // 多行声明折叠为单行
    const fetch = sigs[2];
    assert.ok(fetch?.signature.includes("id: number"));
    assert.ok(
      fetch?.signature.includes(
        "options: { retry?: number; timeoutMs?: number }",
      ),
    );
    assert.ok(!fetch?.signature.includes("\n"));
    assert.equal(fetch?.line, 7);
  });

  it("buildSignatures 无 LSP 时 source=heuristic", () => {
    const data = buildSignatures(tsText, "typescript", null);
    assert.equal(data.source, "heuristic");
    assert.ok(data.signatures.length >= 4);
  });

  it("markdown 无函数签名", () => {
    const data = buildSignatures("# 标题\n", "markdown", null);
    assert.equal(data.source, "markdown");
    assert.equal(data.signatures.length, 0);
  });
});

const pyText = [
  "def top(a, b):",
  "    return a + b",
  "",
  "class Service:",
  "    def __init__(self, base):",
  "        self.base = base",
  "",
  "    async def stop(self,",
  "                 graceful: bool = True,",
  "                 timeout: int = 5):",
  "        return graceful and timeout",
  "",
].join("\n");

describe("Python 启发式签名", () => {
  it("顶层函数 vs 方法（按缩进），多行签名配平", () => {
    const sigs = extractPythonSignatures(pyText);
    assert.deepEqual(
      sigs.map((s) => `${s.kind}:${s.name}`),
      ["function:top", "method:__init__", "method:stop"],
    );
    const stop = sigs[2];
    assert.ok(stop?.signature.includes("graceful: bool = True"));
    assert.ok(stop?.signature.endsWith(")"));
    assert.ok(!stop?.signature.includes("\n"));
  });
});

describe("LSP 签名来源", () => {
  it("递归收集 function/method/constructor 并回填源码行", () => {
    const data = buildSignatures(
      ["function alpha(x: number): number {", "  return x;", "}"].join("\n"),
      "typescript",
      [
        {
          name: "Klass",
          kind: "class",
          line: 1,
          children: [
            { name: "beta", kind: "method", line: 1 },
            {
              name: "gamma",
              kind: "constructor",
              line: 2,
              signature: "constructor(deps: unknown)",
            },
          ],
        },
        { name: "alpha", kind: "function", line: 1 },
        { name: "skipMe", kind: "variable", line: 3 },
      ],
    );
    assert.equal(data.source, "lsp");
    assert.deepEqual(
      data.signatures.map((s) => s.name),
      ["beta", "gamma", "alpha"],
    );
    // 无 signature 字段时从源码行还原
    assert.ok(
      data.signatures[0]?.signature.includes(
        "function alpha(x: number): number {",
      ),
    );
    // 有 signature 字段时直接使用
    assert.equal(data.signatures[1]?.signature, "constructor(deps: unknown)");
  });
});
