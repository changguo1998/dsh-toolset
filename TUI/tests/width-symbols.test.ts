// tests/width-symbols.test.ts — 「呈现不确定」符号列表落盘（profile 目录内 tui-width-symbols.json）
//
// 只记「哪些码点值得实测」，**不记宽度**：宽度每次会话重新实测（内存表 `WIDTH_OVERRIDES`），
// 于是换终端 / tmux / 字体 / 字号自动正确（用户 2026-10-12 裁定，见 layout/width-symbols.ts）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WIDTH_SYMBOLS_FILE,
  readWidthSymbols,
  widthSymbolsPath,
  writeWidthSymbols,
} from "../src/app/layout/width-symbols.ts";

const makeDir = (): string => mkdtempSync(join(tmpdir(), "tui-width-symbols-"));

test("符号列表：写入 → 读回（去重、非法码点丢弃、原子替换无 .tmp 残留）", () => {
  const d = makeDir();
  try {
    assert.equal(
      writeWidthSymbols(d, [0x2713, 0x2713, -1, 0x110000, 0x1f600]),
      true,
    );
    assert.deepEqual(readWidthSymbols(d), [0x2713, 0x1f600]);
    const raw = JSON.parse(readFileSync(widthSymbolsPath(d), "utf8")) as {
      version?: unknown;
      symbols?: unknown;
    };
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.symbols, ["2713", "1f600"]);
    assert.equal(
      existsSync(join(d, `${WIDTH_SYMBOLS_FILE}.tmp`)),
      false,
      "原子替换后无临时文件残留",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("符号列表：缺失 / 损坏 / 版本不符 / symbols 非数组 → 空列表（回落静态表，不阻塞启动）", () => {
  const d = makeDir();
  try {
    assert.deepEqual(readWidthSymbols(d), [], "缺失 → 空");
    writeFileSync(widthSymbolsPath(d), "{ not json", "utf8");
    assert.deepEqual(readWidthSymbols(d), [], "损坏 → 空");
    writeFileSync(
      widthSymbolsPath(d),
      JSON.stringify({ version: 99, symbols: ["2713"] }),
      "utf8",
    );
    assert.deepEqual(readWidthSymbols(d), [], "版本不符 → 空");
    writeFileSync(
      widthSymbolsPath(d),
      JSON.stringify({ version: 1, symbols: "2713" }),
      "utf8",
    );
    assert.deepEqual(readWidthSymbols(d), [], "symbols 非数组 → 空");
    writeFileSync(
      widthSymbolsPath(d),
      JSON.stringify({ version: 1, symbols: ["2713", 42, "zz", "2713"] }),
      "utf8",
    );
    assert.deepEqual(
      readWidthSymbols(d),
      [0x2713],
      "非字符串 / 非法码点 / 重复项一律丢弃",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("符号列表：不设上限（1000 条全保留，顺序 = 最近出现靠后）", () => {
  const d = makeDir();
  try {
    const cps = Array.from({ length: 1000 }, (_, i) => 0x4e00 + i);
    assert.equal(writeWidthSymbols(d, cps), true);
    const back = readWidthSymbols(d);
    assert.equal(back.length, 1000, "不设上限、不淘汰");
    assert.equal(back[0], 0x4e00);
    assert.equal(back[999], 0x4e00 + 999, "尾部 = 最近出现");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
