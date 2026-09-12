// tests/prune.test.ts — pruned 模式：预算、头尾比例、省略标记、边界吸附
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { estimateTokens, isBoundaryLine, pruneText } from "../src/prune.ts";

/** 生成 n 行文本，每 blankEvery 行插一个空行（制造边界）。 */
function makeText(n: number, blankEvery = 0): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    lines.push(`line-${String(i).padStart(3, "0")}: payload`);
    if (blankEvery > 0 && i % blankEvery === 0) lines.push("");
  }
  return lines.join("\n");
}

describe("pruned 预算与裁剪", () => {
  it("预算内文件返回全文 truncated=false", () => {
    const text = makeText(50);
    const out = pruneText(text, { maxLines: 200, maxTokens: 4000 });
    assert.equal(out.truncated, false);
    assert.equal(out.text, text);
    assert.equal(out.keptHead, 50);
    assert.equal(out.elidedLines, 0);
  });

  it("超预算时输出行数 = 头 + 尾 + 1 标记行，且不超过 maxLines", () => {
    const text = makeText(300);
    const out = pruneText(text, { maxLines: 100, maxTokens: 4000 });
    assert.equal(out.truncated, true);
    const outLines = out.text.split("\n");
    assert.ok(outLines.length <= 100, `输出 ${outLines.length} 行应 <= 100`);
    assert.equal(outLines.length, out.keptHead + out.keptTail + 1);
    // 省略标记在头尾之间，计数正确
    const markerIdx = outLines.findIndex((l) => l.startsWith("... ["));
    assert.ok(
      markerIdx === out.keptHead,
      `标记应在第 ${out.keptHead} 行（0 基）`,
    );
    // 恒等式：总行数 = 头 + 尾 + 省略 + 1 标记行
    assert.equal(
      out.elidedLines,
      out.totalLines - out.keptHead - out.keptTail - 1,
    );
    assert.ok(out.text.includes("共 300 行"));
  });

  it("头部约 2/3 尾部约 1/3", () => {
    const text = makeText(300);
    const out = pruneText(text, { maxLines: 90, maxTokens: 4000 });
    // 内容预算 89：head≈59 tail≈30（吸附可能 ±5 行）
    assert.ok(out.keptHead >= 45 && out.keptHead <= 65, `head=${out.keptHead}`);
    assert.ok(out.keptTail >= 15 && out.keptTail <= 40, `tail=${out.keptTail}`);
    assert.ok(out.keptHead > out.keptTail);
  });

  it("token 预算更紧时按字符预算削减", () => {
    const text = makeText(300); // 每行 ~25 字符，共 ~7.5KB
    const out = pruneText(text, { maxLines: 1000, maxTokens: 80 }); // 80 token = 320 字符
    const outLines = out.text.split("\n");
    assert.ok(
      outLines.length <= 20,
      `token 预算下应显著更短，实际 ${outLines.length} 行`,
    );
    assert.ok(
      out.estimatedTokens <= 100 + 20,
      `估算 ${out.estimatedTokens} token 应接近上限（含省略标记开销）`,
    );
  });

  it("切点吸附到空行边界", () => {
    // 边界每 25 行一个；maxLines=40 → head≈26 名义切点，应吸附到 25 行处的空行
    const text = makeText(300, 25);
    const out = pruneText(text, { maxLines: 40, maxTokens: 4000 });
    assert.ok(out.keptHead >= 20 && out.keptHead <= 27, `head=${out.keptHead}`);
    // 切点吸附后，被省略区首行（原始 0 基行号 = keptHead）应为边界空行
    const orig = text.split("\n");
    assert.equal(orig[out.keptHead], "", "省略区首行应为吸附到的空行边界");
  });
});

describe("token 估算与边界判定", () => {
  it("estimateTokens = ceil(len/4)", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(estimateTokens(""), 0);
  });

  it("边界行：空行/标题/分隔线/闭合括号/顶层语句", () => {
    assert.ok(isBoundaryLine(""));
    assert.ok(isBoundaryLine("## 小节"));
    assert.ok(isBoundaryLine("---"));
    assert.ok(isBoundaryLine("}"));
    assert.ok(isBoundaryLine("  }"));
    assert.ok(isBoundaryLine("const x = 1;"));
    assert.ok(!isBoundaryLine("  const x = 1;")); // 缩进行不是顶层语句边界
    assert.ok(!isBoundaryLine("function foo("));
  });
});
