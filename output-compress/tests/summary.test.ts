/**
 * 确定性派生测试：同输入同输出（跨 VmSandbox 与模拟 code-runtime 环境）、
 * 统计正确性、section 标题 / 关键行 / 切片索引结构。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { VmSandbox } from "../src/sandbox.ts";
import {
  SUMMARY_PROGRAM,
  type SummaryJson,
  validateSummary,
} from "../src/summary-program.ts";

/** 模拟宿主 code-runtime 的执行语义（async 函数体 + input 全局绑定），用于交叉验证单一程序源。 */
async function simulateCodeRuntime(text: string): Promise<SummaryJson> {
  const source = `(async () => {\n${SUMMARY_PROGRAM}\n})()`;
  const promise = runInNewContext(
    source,
    { input: { text: async () => text }, TextEncoder },
    { timeout: 30_000 },
  ) as Promise<unknown>;
  return validateSummary(await promise);
}

/** 构造 30KB 的确定性样例文本（含标题、关键行、普通行）。 */
function makeSampleText(): string {
  const lines: string[] = [];
  lines.push("# Build Report");
  lines.push("");
  for (let i = 1; i <= 500; i++) {
    lines.push(`step ${i}: processed ${i * 7} items`);
  }
  lines.push("");
  lines.push("## Errors");
  lines.push("");
  lines.push("ERROR step 42 failed: connection refused");
  for (let i = 501; i <= 1000; i++) {
    lines.push(`step ${i}: processed ${i * 7} items`);
  }
  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  lines.push("WARN deprecated API used at line 99");
  for (let i = 1001; i <= 3000; i++) {
    lines.push(`tail line ${i}: padding data ${i % 100}`);
  }
  return lines.join("\n");
}

test("确定性：同一文本两次独立 VmSandbox 运行 → 摘要逐字节相同", async () => {
  const text = makeSampleText();
  const a = await new VmSandbox().run(text);
  const b = await new VmSandbox().run(text);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("单一程序源不变量：vm 回落与模拟 code-runtime 结果一致", async () => {
  const text = makeSampleText();
  const vm = await new VmSandbox().run(text);
  const cr = await simulateCodeRuntime(text);
  assert.equal(JSON.stringify(vm), JSON.stringify(cr));
});

test("统计块：行数/字节数正确（ASCII 样例 bytes === chars）", async () => {
  const text = makeSampleText();
  const s = await new VmSandbox().run(text);
  assert.equal(s.stats.lines, text.split("\n").length);
  assert.equal(s.stats.bytes, text.length); // 纯 ASCII
  assert.equal(
    s.stats.maxLineLen,
    Math.max(...text.split("\n").map((l) => l.length)),
  );
});

test("section 标题：捕获行号与级别", async () => {
  const s = await new VmSandbox().run(makeSampleText());
  assert.deepEqual(
    s.headings.map((h) => [h.level, h.text]),
    [
      [1, "Build Report"],
      [2, "Errors"],
      [2, "Warnings"],
    ],
  );
  assert.ok(s.headings.every((h) => h.line >= 1));
});

test("关键行：错误类关键词命中且限量 20 条", async () => {
  const lines = ["header"];
  for (let i = 1; i <= 30; i++) lines.push(`ERROR failure case ${i}`);
  const s = await new VmSandbox().run(lines.join("\n"));
  assert.equal(s.keyLines.length, 20);
  assert.ok(s.keyLines.every((k) => k.text.includes("ERROR")));
  assert.equal(s.keyLines[0]?.line, 2);
});

test("关键行：超长行（>400 字符）跳过", async () => {
  const text = ["ERROR " + "x".repeat(500), "ok line"].join("\n");
  const s = await new VmSandbox().run(text);
  assert.equal(s.keyLines.length, 0);
});

test("切片索引：16 片覆盖全文、行/字符范围单调连续", async () => {
  const text = makeSampleText();
  const s = await new VmSandbox().run(text);
  assert.ok(s.slices.length >= 1 && s.slices.length <= 16);
  const first = s.slices[0];
  const last = s.slices[s.slices.length - 1];
  assert.ok(first !== undefined && last !== undefined);
  assert.equal(first.startLine, 1);
  assert.equal(last.endLine, text.split("\n").length);
  // 单调性：后一片起点不小于前一片终点
  for (let i = 1; i < s.slices.length; i++) {
    const prev = s.slices[i - 1];
    const cur = s.slices[i];
    assert.ok(prev !== undefined && cur !== undefined);
    assert.ok(cur.startLine > prev.endLine);
    assert.ok(cur.startChar >= prev.endChar - 1); // 末行无换行时允许 ±1
  }
  // 首片预览 = 首行（≤80 字符）
  assert.equal(first.preview, "# Build Report"); // 预览保留原始行首
  // 指纹为 8 位十六进制
  assert.ok(s.slices.every((sl) => /^[0-9a-f]{8}$/.test(sl.fnv)));
  // 全文指纹稳定
  assert.match(s.textFnv, /^[0-9a-f]{8}$/);
});

test("空文本不崩溃且结构合法", async () => {
  const s = await new VmSandbox().run("");
  assert.equal(s.stats.lines, 1); // "".split("\n") → [""]
  assert.ok(s.slices.length >= 1);
  assert.equal(s.headings.length, 0);
  assert.equal(s.keyLines.length, 0);
});

test("validateSummary：非法结构抛错", () => {
  assert.throws(() => validateSummary(null));
  assert.throws(() => validateSummary({}));
  assert.throws(() =>
    validateSummary({
      version: 2,
      textFnv: "abcd1234",
      stats: {},
      headings: [],
      keyLines: [],
      slices: [],
    }),
  );
});
