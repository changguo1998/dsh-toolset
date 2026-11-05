import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GLOSSARY_SNAPSHOT } from "../src/glossary.generated.ts";

/** 本包目录与仓库根。 */
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PKG_DIR, "..");
const GEN_SCRIPT = join(PKG_DIR, "scripts/gen-glossary.mjs");

/** 跑生成脚本（`--check` 模式），返回 stdout 与退出码。 */
function runCheck(root?: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const args = [
    GEN_SCRIPT,
    "--check",
    ...(root === undefined ? [] : ["--root", root]),
  ];
  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

test("快照与当前 docs/GLOSSARY.md 一致", () => {
  const result = runCheck();
  assert.equal(result.status, 0, `快照与 GLOSSARY 不一致: ${result.stderr}`);
  assert.match(result.stdout, /ok: 快照与 GLOSSARY 一致（\d+ 行）/);
});

test("反向验证：GLOSSARY 改了不重跑快照, 校验会失败", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "term-check-glossary-"));
  try {
    mkdirSync(join(tempRoot, "docs"), { recursive: true });
    const source = readFileSync(join(REPO_ROOT, "docs/GLOSSARY.md"), "utf8");
    // 在「禁止术语」表末追加一行, 模拟改了表却没重跑生成脚本
    const patched = source.replace(
      "\n## 保留",
      "\n| 临时旧称 | 临时新称 | 测试用行 |\n\n## 保留",
    );
    assert.notEqual(patched, source);
    writeFileSync(join(tempRoot, "docs/GLOSSARY.md"), patched, "utf8");
    const result = runCheck(tempRoot);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /快照与 docs\/GLOSSARY\.md 不一致/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("豁免标记与已知误配和 dev/standard 同口径", () => {
  const rules = readFileSync(join(REPO_ROOT, "dev/standard/rules.mjs"), "utf8");
  for (const marker of ["原名", "旧称", "历史对照", "不再使用"]) {
    assert.ok(rules.includes(marker), `rules.mjs 缺豁免标记「${marker}」`);
  }
  assert.ok(rules.includes("夺回归属"), "rules.mjs 缺已知误配片段「夺回归属」");
});

test("快照行数与 GLOSSARY「禁止术语」表行数一致", () => {
  const glossary = readFileSync(join(REPO_ROOT, "docs/GLOSSARY.md"), "utf8");
  const section = glossary.slice(glossary.indexOf("## 禁止术语"));
  const tableEnd = section.indexOf("\n## ");
  const body = tableEnd < 0 ? section : section.slice(0, tableEnd);
  const rows = body
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .slice(2); // 跳过表头与分隔行
  assert.equal(GLOSSARY_SNAPSHOT.length, rows.length);
});
