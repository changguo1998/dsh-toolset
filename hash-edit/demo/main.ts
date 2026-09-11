/**
 * demo: hash-edit 冒烟（脚本化人工回归，无需真实 dsh 会话）。
 *
 * 流程：
 *  1) 在临时目录写入示例文件
 *  2) readHashlines 获取 LINE:HASH 锚点（模拟 hash_read 工具）
 *  3) applyAnchoredEditsFile 多锚点一次提交（set_line + insert_after + delete_line）
 *  4) 模拟外部修改 → 旧锚点整批拒绝（stale_anchors），文件字节不变
 *  5) 校验无临时文件残留；全部通过打印 SMOKE_PASS
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnchoredEditError } from "../src/edit.ts";
import { hashlines } from "../src/hashline.ts";
import { applyAnchoredEditsFile, listDir, readHashlines } from "../src/fs.ts";

const INITIAL = ["alpha", "beta", "", "delta", "epsilon"].join("\n") + "\n";
const EXPECTED_AFTER = ["A1", "beta", "", "mid", "delta"].join("\n") + "\n";

function check(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`SMOKE_FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`ok - ${label}`);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hash-edit-demo-"));
  const path = join(dir, "demo.txt");
  try {
    // 1) 示例文件
    await writeFile(path, INITIAL, "utf8");

    // 2) 锚点读取
    const read = await readHashlines(path);
    check(read.line_count === 5, `line_count == 5 (got ${read.line_count})`);
    check(
      read.hashlines.every((r) =>
        /^\d+:[0-9a-f]{8}$/.test(`${r.line}:${r.hash}`),
      ),
      "all anchors match LINE:HASH grammar",
    );
    const anchor = (line: number): string => {
      const row = hashlines(INITIAL)[line - 1];
      if (!row) throw new Error(`line ${line} missing`);
      return `${row.line}:${row.hash}`;
    };

    // 3) 多锚点一次提交：set 1 + insert after 3 + delete 5（乱序提交）
    const res = await applyAnchoredEditsFile(path, [
      { delete_line: { anchor: anchor(5) } },
      { set_line: { anchor: anchor(1), new_text: "A1" } },
      { insert_after: { anchor: anchor(3), new_text: "mid" } },
    ]);
    check(
      res.content === EXPECTED_AFTER,
      "multi-anchor batch applied in anchor-line order",
    );
    check(
      (await readFile(path, "utf8")) === EXPECTED_AFTER,
      "file bytes match result content",
    );

    // 4) 外部修改后旧锚点整批拒绝
    await writeFile(path, "ALPHA'\nbeta\n\ndelta\nepsilon\n", "utf8");
    let stale: AnchoredEditError | undefined;
    try {
      await applyAnchoredEditsFile(path, [
        { set_line: { anchor: anchor(1), new_text: "X" } }, // stale
        { set_line: { anchor: anchor(3), new_text: "Y" } }, // 空行仍匹配
      ]);
    } catch (err) {
      if (err instanceof AnchoredEditError) stale = err;
      else throw err;
    }
    check(
      stale !== undefined && stale.code === "stale_anchors",
      "stale batch rejected",
    );
    check(
      stale?.details.length === 1 && stale?.details[0]?.line === 1,
      "only the stale line reported",
    );
    check(
      (await readFile(path, "utf8")) === "ALPHA'\nbeta\n\ndelta\nepsilon\n",
      "file unchanged after rejection",
    );

    // 5) 无临时文件残留
    const entries = await listDir(dir);
    check(
      entries.length === 1 && entries[0] === "demo.txt",
      "no temp file residue",
    );

    console.log("SMOKE_PASS");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
