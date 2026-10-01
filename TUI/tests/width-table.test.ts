// tests/width-table.test.ts — 实测宽度表落盘（profile 目录内 tui-width-table.json）
//
// 覆盖：往返读写、终端标识不匹配作废、非法值过滤、文件缺失/损坏回落空表。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWidthTable,
  terminalKey,
  widthTablePath,
  writeWidthTable,
} from "../src/app/layout/width-table.ts";

/** 在临时 profile 目录内跑一个用例（跑完删除目录） */
function withProfileDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tui-width-table-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writeWidthTable/readWidthTable：往返一致，非 1/2 列的值不落盘", () => {
  withProfileDir((dir) => {
    const term = "xterm-256color|iTerm.app|truecolor";
    assert.equal(
      writeWidthTable(dir, term, [
        ["\u27A1", 1], // ➡ 实测 1 列
        ["\u2B05", 2], // ⬅ 实测 2 列
        ["\u4E2D", 3], // 中：非法值（只有 1/2 列可落盘）
        ["", 1], // 空字符：无码点
      ]),
      true,
    );
    const back = readWidthTable(dir, term);
    assert.equal(back.get("\u27A1"), 1);
    assert.equal(back.get("\u2B05"), 2);
    assert.equal(back.has("\u4E2D"), false, "非法宽度不入表");
    assert.equal(back.size, 2);
    // 落盘内容为最小 JSON（码点 hex 键）
    const raw = JSON.parse(readFileSync(widthTablePath(dir), "utf8")) as {
      term: string;
      widths: Record<string, number>;
    };
    assert.equal(raw.term, term);
    assert.deepEqual(Object.keys(raw.widths).sort(), ["27a1", "2b05"]);
  });
});

test("readWidthTable：终端标识不匹配 → 空表（换终端/字体后旧值不可信）", () => {
  withProfileDir((dir) => {
    writeWidthTable(dir, "xterm-256color||", [["\u27A1", 1]]);
    assert.equal(readWidthTable(dir, "xterm-256color||").get("\u27A1"), 1);
    assert.equal(
      readWidthTable(dir, "tmux-256color||").size,
      0,
      "换终端 → 整表作废",
    );
  });
});

test("readWidthTable：文件缺失 / 损坏 / 版本不符 → 空表（不抛错）", () => {
  withProfileDir((dir) => {
    assert.equal(readWidthTable(dir, "x||").size, 0, "缺失 → 空表");
    writeFileSync(widthTablePath(dir), "{ not json", "utf8");
    assert.equal(readWidthTable(dir, "x||").size, 0, "损坏 → 空表");
    writeFileSync(
      widthTablePath(dir),
      JSON.stringify({ version: 99, term: "x||", widths: { "27a1": 1 } }),
      "utf8",
    );
    assert.equal(readWidthTable(dir, "x||").size, 0, "版本不符 → 空表");
  });
});

test("terminalKey：TERM|TERM_PROGRAM|COLORTERM 拼接（缺项按空串占位）", () => {
  assert.equal(
    terminalKey({
      TERM: "xterm-256color",
      TERM_PROGRAM: "iTerm.app",
      COLORTERM: "truecolor",
    }),
    "xterm-256color|iTerm.app|truecolor",
  );
  assert.equal(terminalKey({ TERM: "linux" }), "linux||");
  assert.equal(terminalKey({}), "||");
});
