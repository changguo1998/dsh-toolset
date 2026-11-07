// TUI/tests/status-wrap-strategy.test.ts — 状态列折行策略（任务表 E1 / E2）
//
// 覆盖：
//  - E1：条目叶子透传折行属性；L3 折叠态仍「一条一行」（`{ mode: "none" }`）
//  - E2：各块按内容选风格——Goal objective / Todo / Flow slug 用按词断点，
//        窄列下不在词中间断开；jobs / 阻塞原因保持单行

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStatusColumn } from "../src/app/layout/title-bar.ts";
import type { TodoItemLike } from "../src/app/adapter/dsh.ts";

/** 行文本（去掉行尾空白，便于断言） */
const lines = (
  rows: readonly { segments: readonly { text: string }[] }[],
): string[] =>
  rows.map((row) =>
    row.segments
      .map((s) => s.text)
      .join("")
      .replace(/\s+$/u, ""),
  );

const todo = (content: string): TodoItemLike => ({
  content,
  status: "in_progress",
});

test("E1：L3 折叠时条目仍一条一行（不软折行）", () => {
  // 高度 3 → 折叠到 L3；长文本不折行，交给拼帧层截断
  const folded = lines(
    renderStatusColumn(
      undefined,
      [todo("abcdefghijklmnopqrstuvwxyz")],
      undefined,
      0,
      3,
      8,
    ),
  );
  assert.equal(folded.length, 2, "标题 + 一条条目");
  assert.equal(folded[1], "● abcdefghijklmnopqrstuvwxyz");

  // 高度充裕 → 不折叠，按列宽折成多行
  const wrapped = lines(
    renderStatusColumn(
      undefined,
      [todo("abcdefghijklmnopqrstuvwxyz")],
      undefined,
      0,
      30,
      8,
    ),
  );
  assert.ok(wrapped.length > 2, "未折叠时应折行");
});

test("E1：jobs 条目保持单行（改造前「一条一行」）", () => {
  const jobs = [
    {
      id: "j1",
      kind: "shell",
      label: "abcdefghijklmnopqrstuvwxyz",
      status: "running" as const,
      startedAt: 0,
    },
  ];
  const rows = lines(renderStatusColumn(undefined, undefined, jobs, 0, 30, 8));
  assert.equal(rows.length, 2, "标题 + 一条任务行");
});

// ---------------- E2：各块按词断行 ----------------

test("E2：Goal objective 窄列下不在词中间断开", () => {
  const goals = [
    {
      operation: "create" as const,
      goal: {
        id: "g0",
        revision: 1,
        objective: "alpha-beta-gamma-delta",
        phase: "active" as const,
      },
    },
  ];
  const rows = lines(
    renderStatusColumn(goals, undefined, undefined, 0, 30, 10),
  );
  assert.deepEqual(rows.slice(1), ["alpha-", "beta-", "gamma-", "delta"]);
});

test("E2：Flow slug 窄列下按词断点折行", () => {
  const extras = {
    flow: {
      stage: "实现",
      items: [
        {
          slug: "wrap-strategy-core",
          stage: "实现",
          status: "active",
          active: true,
        },
      ],
    },
  };
  const rows = lines(
    renderStatusColumn(
      undefined,
      undefined,
      undefined,
      0,
      30,
      12,
      undefined,
      undefined,
      0,
      undefined,
      extras,
    ),
  );
  // 标题行 + 条目行；slug 在 `-` 处断开（窄列下超宽单元仍回落逐字符）
  assert.ok(rows.length >= 2, "应有标题与条目行");
  const chunks = rows
    .slice(1)
    .map((r) => r.trim())
    .filter((r) => r !== "");
  assert.ok(
    chunks.some((c) => c.endsWith("-")),
    `连字符处应可断：${JSON.stringify(chunks)}`,
  );
});
