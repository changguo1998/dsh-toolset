// demo/main.ts — fs_digest 三模式本地示例（无 DSH 依赖，直接调用核心 digest）。
// 运行：npm run demo
import { join } from "node:path";
import { digest } from "../src/digest.ts";
import type { DigestResult, OutlineNode } from "../src/types.ts";

const FIXTURES = join(import.meta.dirname, "..", "tests", "fixtures");

/** 渲染并打印一种结果：outline 树 / signatures 列表 / pruned 正文 / 错误。 */
function show(title: string, result: DigestResult): void {
  console.log(`\n=== ${title} ===`);
  if (!result.ok) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.mode === "outline") {
    const lines: string[] = [];
    const walk = (nodes: OutlineNode[], depth: number): void => {
      for (const n of nodes) {
        lines.push(`${"  ".repeat(depth - 1)}L${n.line} ${n.kind} ${n.name}`);
        walk(n.children, depth + 1);
      }
    };
    walk(result.nodes, 1);
    console.log(`(source: ${result.source})\n${lines.join("\n")}`);
    return;
  }
  if (result.mode === "signatures") {
    const body = result.signatures.map((s) => `L${s.line} ${s.signature}`).join("\n");
    console.log(`(source: ${result.source})\n${body === "" ? "(无签名)" : body}`);
    return;
  }
  console.log(`(truncated: ${result.truncated}, elided: ${result.elidedLines} 行)\n${result.text}`);
}

const tsFile = join(FIXTURES, "sample.ts");
const mdFile = join(FIXTURES, "sample.md");
const pyFile = join(FIXTURES, "sample.py");
const bigFile = join(FIXTURES, "big.log");

// 1) outline：TS 启发式
show("outline(sample.ts, 无 LSP → 启发式)", await digest(null, tsFile, { mode: "outline", depth: 2 }));
// 2) outline：Markdown
show("outline(sample.md)", await digest(null, mdFile, { mode: "outline", depth: 2 }));
// 3) signatures：Python 启发式
show("signatures(sample.py)", await digest(null, pyFile, { mode: "signatures" }));
// 4) pruned：大日志头尾裁剪
show("pruned(big.log, maxLines=12)", await digest(null, bigFile, { mode: "pruned", maxLines: 12 }));
// 5) requireLsp：无 LSP 宿主下显式失败
show(
  "outline(sample.ts, requireLsp=true → lsp_unavailable)",
  await digest(null, tsFile, { mode: "outline", requireLsp: true }),
);
