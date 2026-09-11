/**
 * 规则执行测试：YAML 规则文件（含 fix）、内联规则、关系子句（inside）、
 * 命中元数据（ruleId/severity/message/replacement）、无命中与错误路径。
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { AstGrepProcessError } from "../src/binary.ts";
import { runRules } from "../src/rules.ts";
import { astTest, withTempDir, writeFixture } from "./helpers.ts";

/** 写规则文件 fixture。 */
function writeRule(dir: string, yaml: string): string {
  const file = writeFixture(dir, "rule.yml", yaml);
  return file;
}

astTest("规则文件：fix 规则的命中带 replacement", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const rule = writeRule(
      dir,
      [
        "id: no-console-log",
        "language: typescript",
        "message: 禁止 console.log，改用 console.info",
        "severity: warning",
        "rule:",
        "  pattern: console.log($MSG)",
        "fix: console.info($MSG)",
        "",
      ].join("\n"),
    );
    const target = writeFixture(
      dir,
      "a.ts",
      "console.log('x');\nconsole.info('ok');\n",
    );
    const hits = await runRules({
      rule: { kind: "file", rulePath: rule },
      paths: [target],
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.ruleId, "no-console-log");
    assert.equal(hits[0]?.severity, "warning");
    assert.equal(hits[0]?.message, "禁止 console.log，改用 console.info");
    assert.equal(hits[0]?.text, "console.log('x')");
    assert.equal(hits[0]?.replacement, "console.info('x')");
    assert.ok(hits[0]?.replacementOffsets, "fix 规则附替换区间");
  } finally {
    cleanup();
  }
});

astTest("内联规则：无 fix 时命中不带 replacement", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const target = writeFixture(dir, "a.py", "import os\nprint(1)\n");
    const hits = await runRules({
      rule: {
        kind: "inline",
        rules: [
          "id: no-print",
          "language: python",
          "message: 避免 print",
          "severity: warning",
          "rule:",
          "  pattern: print($$$ARGS)",
          "",
        ].join("\n"),
      },
      paths: [target],
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.ruleId, "no-print");
    assert.equal(hits[0]?.replacement, undefined);
  } finally {
    cleanup();
  }
});

astTest("关系子句 inside：仅命中函数内的 eval", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const rule = writeRule(
      dir,
      [
        "id: eval-in-fn",
        "language: javascript",
        "message: 函数内禁止 eval",
        "severity: error",
        "rule:",
        "  all:",
        "    - pattern: eval($X)",
        "    - inside:",
        "        pattern: function $NAME($$$) { $$$ }",
        "        stopBy: end",
        "",
      ].join("\n"),
    );
    const target = writeFixture(
      dir,
      "a.js",
      "function f() { eval('1') }\neval('2')\n",
    );
    const hits = await runRules({
      rule: { kind: "file", rulePath: rule },
      paths: [target],
    });
    assert.equal(hits.length, 1, "顶层 eval 不命中，函数内 eval 命中");
    assert.equal(hits[0]?.text, "eval('1')");
    assert.equal(hits[0]?.severity, "error");
  } finally {
    cleanup();
  }
});

astTest("无命中：返回空数组（非零退出码被 JSON 输出吸收）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const rule = writeRule(
      dir,
      [
        "id: never-match",
        "language: typescript",
        "message: 不存在",
        "severity: warning",
        "rule:",
        "  pattern: alert(123456)",
        "",
      ].join("\n"),
    );
    const target = writeFixture(dir, "a.ts", "const x = 1;\n");
    const hits = await runRules({
      rule: { kind: "file", rulePath: rule },
      paths: [target],
    });
    assert.deepEqual(hits, []);
  } finally {
    cleanup();
  }
});

astTest("规则文件不存在：抛 AstGrepProcessError", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const target = writeFixture(dir, "a.ts", "const x = 1;\n");
    await assert.rejects(
      runRules({
        rule: { kind: "file", rulePath: `${dir}/missing.yml` },
        paths: [target],
      }),
      AstGrepProcessError,
    );
    // 规则文件存在但内容非法（语言不存在）同样走 ProcessError
    const bad = writeRule(
      dir,
      [
        "id: bad-lang",
        "language: not-a-language",
        "message: x",
        "rule:",
        "  pattern: f()",
      ].join("\n"),
    );
    await assert.rejects(
      runRules({ rule: { kind: "file", rulePath: bad }, paths: [target] }),
      /ast-grep 执行失败/,
    );
    // 保证 writeRule 产物清理由 cleanup 覆盖（无额外句柄）
    void writeFileSync; // 占位引用，防未来精简 import 时报 unused
  } finally {
    cleanup();
  }
});
