/**
 * 流水单测：追加 / 读取 / 过滤 / 有界轮转 / 坏行跳过。
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_JOURNAL_LIMIT, Journal } from "../src/journal.ts";
import type { RunRecord } from "../src/types.ts";

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "background-daemon-journal-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(index: number, taskId = "d-1"): RunRecord {
  return {
    taskId,
    at: 1_000 + index,
    sessionId: "sess",
    mode: "deliver",
    outcome: "delivered",
    error: null,
    durationMs: index,
    detail: null,
  };
}

function lineCount(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

test("append/tail：时间正序、默认取最近 20 条", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "journal.jsonl");
    const journal = new Journal(file);
    journal.load();
    for (let index = 0; index < 25; index += 1) journal.append(record(index));
    const tail = journal.tail();
    assert.equal(tail.length, 20);
    assert.equal(tail[0]?.at, 1_005);
    assert.equal(tail[19]?.at, 1_024);
    assert.equal(
      journal
        .tail(3)
        .map((item) => item.at)
        .join(","),
      "1022,1023,1024",
    );
  });
});

test("tail：按任务 id 过滤", () => {
  withTmpDir((dir) => {
    const journal = new Journal(path.join(dir, "journal.jsonl"));
    journal.load();
    journal.append(record(0, "d-a"));
    journal.append(record(1, "d-b"));
    journal.append(record(2, "d-a"));
    assert.deepEqual(
      journal.tail(10, "d-a").map((item) => item.at),
      [1_000, 1_002],
    );
    assert.equal(journal.tail(10, "d-missing").length, 0);
  });
});

test("有界：两代文件各自不超过上限, 最旧轮转到 .1", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "journal.jsonl");
    const journal = new Journal(file, { limit: 5 });
    journal.load();
    // 写 12 条：轮转发生在「追加前已达上限」时（第 6 / 11 条前各轮转一次）
    for (let index = 0; index < 12; index += 1) journal.append(record(index));
    const current = lineCount(file);
    const rotated = lineCount(`${file}.1`);
    assert.equal(rotated, 5);
    assert.equal(current, 2);
    assert.ok(current <= 5 && rotated <= 5);
    // 盘上总量有界（≤ 2 × limit）
    assert.ok(current + rotated <= 10);
    // 内存只保留最近 limit 条
    assert.deepEqual(
      journal.tail(10).map((item) => item.at),
      [1_007, 1_008, 1_009, 1_010, 1_011],
    );
  });
});

test("有界：恰好写满上限时不轮转, 下一条才轮转", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "journal.jsonl");
    const journal = new Journal(file, { limit: 3 });
    journal.load();
    for (let index = 0; index < 3; index += 1) journal.append(record(index));
    assert.equal(lineCount(file), 3);
    assert.equal(existsSync(`${file}.1`), false);
    journal.append(record(3));
    assert.equal(lineCount(file), 1);
    assert.equal(lineCount(`${file}.1`), 3);
  });
});

test("上限缺省值：与宿主 schedule 的 200 条对齐", () => {
  withTmpDir((dir) => {
    const journal = new Journal(path.join(dir, "journal.jsonl"));
    assert.equal(journal.limit, DEFAULT_JOURNAL_LIMIT);
    assert.equal(journal.limit, 200);
  });
});

test("load：跨进程恢复（主文件 + .1）, 坏行跳过并告警", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "journal.jsonl");
    const journal = new Journal(file, { limit: 5 });
    journal.load();
    for (let index = 0; index < 7; index += 1) journal.append(record(index));

    const warnings: string[] = [];
    const reloaded = new Journal(file, {
      limit: 5,
      onWarn: (message) => warnings.push(message),
    });
    // 手工塞一条坏行（模拟半截写）
    writeFileSync(file, `${readFileSync(file, "utf8")}{ 半截\n`, "utf8");
    const count = reloaded.load();
    assert.equal(count, 5);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /流水坏行/);
  });
});

test("load：文件缺失返回 0 条", () => {
  withTmpDir((dir) => {
    const journal = new Journal(path.join(dir, "journal.jsonl"));
    assert.equal(journal.load(), 0);
    assert.deepEqual(journal.tail(5), []);
  });
});

test("limit 非法（0 / NaN）回落缺省", () => {
  withTmpDir((dir) => {
    assert.equal(
      new Journal(path.join(dir, "a.jsonl"), { limit: 0 }).limit,
      200,
    );
    assert.equal(
      new Journal(path.join(dir, "b.jsonl"), { limit: Number.NaN }).limit,
      200,
    );
  });
});

test("sink：每条流水外送一次；外送抛错不影响本地账本", () => {
  withTmpDir((dir) => {
    const delivered: number[] = [];
    const journal = new Journal(path.join(dir, "journal.jsonl"), {
      sink: (record) => delivered.push(record.at),
    });
    journal.load();
    journal.append(record(0));
    journal.append(record(1));
    assert.deepEqual(delivered, [1_000, 1_001]);

    const failing = new Journal(path.join(dir, "journal2.jsonl"), {
      sink: () => {
        throw new Error("sink 炸了");
      },
    });
    failing.load();
    assert.doesNotThrow(() => failing.append(record(2)));
    assert.equal(failing.tail(5).length, 1);
  });
});
