// tests/helpers.ts — 测试公共辅助：临时工作区与 fixture 写入。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 创建临时目录，返回路径与清理函数。 */
export function withTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "md-logic-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 写入 fixture 文件并返回绝对路径。 */
export function writeFixture(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text, "utf8");
  return file;
}

/** 常用 Markdown fixture（覆盖节、块、链接三类）。 */
export const SAMPLE = [
  "---",
  "title: 示例",
  "tags: [a, b]",
  "---",
  "",
  "# 标题一",
  "",
  "正文 [链接](http://example.com) 与 ![图](img.png)。",
  "",
  "## 小节 1.1",
  "",
  "- 项一",
  "  - 项二",
  "- 项三",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "| 列一 | 列二 |",
  "| --- | --- |",
  "| 1 | 2 |",
  "| 3 | 4 |",
  "",
  "> 引用一",
  "> 引用二",
  "",
  '[ref]: http://ref.example "标题"',
  "",
  "## 小节 1.2",
  "",
  "<div>html 块</div>",
  "",
  "---",
  "",
].join("\n");
