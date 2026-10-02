// tests/helpers.ts — 测试公共辅助：临时「文档项目」fixture（含内部链 / 锚点 / wiki / 文件引用 / 断链）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** 创建临时目录，返回路径与清理函数。 */
export function withTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "md-map-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 写文件（自动建目录）。 */
export function writeFile(root: string, relPath: string, text: string): string {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

/** 标准 fixture 的文档内容（键 = 相对 root 的路径）。 */
export const FIXTURE: Record<string, string> = {
  "README.md": [
    "# 项目",
    "",
    "[A](docs/a.md)",
    "[A 的锚点](docs/a.md#小节)",
    "",
    "[[docs/b]]",
    "",
    "[代码引用](src/x.ts)",
    "[外链](https://example.com)",
    "[断链](docs/missing.md)",
    "",
  ].join("\n"),
  "docs/a.md": [
    "# A",
    "",
    "## 小节",
    "",
    "[回 README](../README.md)",
    "[自引用](#小节)",
    "",
    "```md",
    "[[docs/not-a-wiki-link]]",
    "```",
    "",
  ].join("\n"),
  "docs/b.md": ["# B", "", "无出边（孤儿候选）", ""].join("\n"),
  "docs/sub/c.md": [
    "# C",
    "",
    "[B 的坏锚点](../b.md#不存在)",
    "[目录](../../docs/)",
    "",
  ].join("\n"),
};

/** 落盘标准 fixture（外加一个非 md 文件供 `file` 引用）。 */
export function writeFixture(root: string): void {
  for (const [path, text] of Object.entries(FIXTURE)) {
    writeFile(root, path, text);
  }
  writeFile(root, "src/x.ts", "export const x = 1;\n");
}
