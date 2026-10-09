// tests/pipeline-panes.test.ts — 六步流水线第 3 步「显示准备」的契约
//
// 契约（追踪文档「pane 构建」）：
// ① 归属：user 与 final 节正文 → 会话区；reasoning / 工具批 / 非 final 正文 / notice → 回合区；
// ② 档位过滤：think = 全量；tool = 去思考；step = 只留工具调用（notice 保留）；
// ③ 替换符号只作用于文本（代码 / 表格不替换）；
// ④ 拆行：文本 box → 逻辑行；代码块与表格不拆；
// ⑤ 加边界：scope 变化 → step 头（仅回合区）；turn 变化 → 回合分隔线；分类变化 → 空行；
// ⑥ 合并空行：连续空行并成 1 个。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPanes, type PaneItem } from "../src/app/layout/pipeline/panes.ts";
import type { Item, Section } from "../src/app/layout/pipeline/types.ts";

const section = (items: Item[], extra: Partial<Section> = {}): Section => ({
  turn: 1,
  step: 1,
  items,
  frozen: true,
  ...extra,
});

/** pane 项 → 便于断言的形状（行取文本，边界取标记） */
const shape = (items: readonly PaneItem[]): string[] =>
  items.map((item) => {
    if (item.kind === "blank") return "(blank)";
    if (item.kind === "step-head") return `#step ${item.step}`;
    if (item.kind === "turn-separator") return `-- turn ${item.turn}`;
    const box = item.box;
    if (box.shape === "code") return "code:" + box.code?.lines.join("|");
    if (box.shape === "table") return "table";
    if (box.shape === "tool") return "tool:" + (box.batch?.calls.length ?? 0);
    return box.source + ":" + (box.text ?? "");
  });

test("① 归属：用户块与 final 正文进会话区，思考 / 工具 / 非 final 正文进回合区", () => {
  const panes = buildPanes(
    [
      section([{ source: "user", text: "问题" }], { turn: 1, step: 1 }),
      section(
        [
          { source: "reasoning", text: "（想）" },
          {
            source: "tool",
            calls: [{ callId: "c1", name: "bash", args: "{}" }],
          },
          { source: "assistant", text: "中间正文" },
        ],
        { turn: 1, step: 2 },
      ),
      section([{ source: "assistant", text: "最终答复" }], {
        turn: 1,
        step: 3,
        final: true,
      }),
    ],
    { level: "think" },
  );
  // 会话区：首 pane 内容前有回合分隔线（旧口径 turn-begin 即画线），用户块与 final
  // 正文之间按分类变化留白（旧路径 spaceUserAssistant 口径）
  assert.deepEqual(shape(panes.dialogue), [
    "-- turn 1",
    "user:问题",
    "(blank)",
    "assistant:最终答复",
  ]);
  // 回合区：每个有内容的 step 一个 step 头（旧口径：step 头是工具行，恒进回合区；
  // 该 step 无回合区内容时为孤儿头）；turn 分隔线只在会话区
  assert.deepEqual(shape(panes.activity), [
    "#step 1",
    "#step 2",
    "reasoning:（想）",
    "(blank)",
    "tool:1",
    "(blank)",
    "assistant:中间正文",
    "#step 3",
  ]);
});

test("② 档位过滤：tool 去思考、step 只留工具调用（notice 保留）", () => {
  const sections = [
    section(
      [
        { source: "reasoning", text: "（想）" },
        { source: "assistant", text: "过程" },
        { source: "tool", calls: [{ callId: "c1", name: "bash", args: "{}" }] },
        { source: "notice", text: "提示", tone: "warn" },
      ],
      { turn: 1, step: 2 },
    ),
  ];
  assert.deepEqual(shape(buildPanes(sections, { level: "tool" }).activity), [
    "#step 2",
    "assistant:过程",
    "(blank)",
    "tool:1",
    "(blank)",
    "notice:提示",
  ]);
  // step 档：去思考；工具批内部的**结果行**由第 4 步沿用旧渲染器裁掉（调用行只取首行），
  // 正文与 notice 保留——与旧渲染器同口径
  assert.deepEqual(shape(buildPanes(sections, { level: "step" }).activity), [
    "#step 2",
    "assistant:过程",
    "(blank)",
    "tool:1",
    "(blank)",
    "notice:提示",
  ]);
});

test("③ 替换符号只作用于文本，代码与表格不替换", () => {
  const panes = buildPanes(
    [
      section(
        [
          { source: "assistant", text: "a -> b" },
          { source: "assistant", text: "```ts\nconst a = 1; -> x\n```" },
          {
            source: "assistant",
            text: "| a -> b | c |\n| --- | --- |\n| 1 | 2 |",
          },
        ],
        { turn: 1, step: 2 },
      ),
    ],
    { level: "think", normalize: (text) => text.replace(/->/g, "→") },
  );
  // 正文 / 代码 / 表格同属 assistant：同块内不插空行（旧口径），只断言内容不被替换
  assert.deepEqual(shape(panes.activity), [
    "#step 2",
    "assistant:a → b",
    "code:const a = 1; -> x",
    "table",
  ]);
});

test("④ 拆行：文本 box 拆成逻辑行；代码块与表格保持整块", () => {
  const panes = buildPanes(
    [
      section([{ source: "assistant", text: "第一行\n第二行\n\n第三行" }], {
        turn: 1,
        step: 2,
      }),
    ],
    { level: "think" },
  );
  assert.deepEqual(shape(panes.activity), [
    "#step 2",
    "assistant:第一行",
    "assistant:第二行",
    "(blank)",
    "assistant:第三行",
  ]);
});

test("⑤ 边界：step 头随 scope 变化；turn 分隔线随回合变化；分类变化插空行", () => {
  const panes = buildPanes(
    [
      section([{ source: "assistant", text: "第一步" }], { turn: 1, step: 1 }),
      section([{ source: "assistant", text: "第二步" }], { turn: 1, step: 2 }),
      section([{ source: "assistant", text: "下一回合" }], {
        turn: 2,
        step: 1,
      }),
    ],
    { level: "think" },
  );
  assert.deepEqual(shape(panes.activity), [
    "#step 1",
    "assistant:第一步",
    "#step 2",
    "assistant:第二步",
    "#step 1",
    "assistant:下一回合",
  ]);
  // turn 分隔线只在会话区（旧口径：分隔线是会话区的线）
  const dialogue = buildPanes(
    [
      section([{ source: "user", text: "第一问" }], { turn: 1, step: 1 }),
      section([{ source: "assistant", text: "第一答" }], {
        turn: 1,
        step: 1,
        final: true,
      }),
      section([{ source: "user", text: "第二问" }], { turn: 2, step: 1 }),
    ],
    { level: "think" },
  );
  assert.ok(
    shape(dialogue.dialogue).includes("-- turn 2"),
    "会话区在回合变化处插分隔线",
  );
});

test("⑥ 合并空行：连续空行并成 1 个（代码块内不合并）", () => {
  const panes = buildPanes(
    [
      section(
        [
          { source: "assistant", text: "正文\n\n\n\n正文二" },
          { source: "reasoning", text: "（想）" },
        ],
        { turn: 1, step: 2 },
      ),
    ],
    { level: "think" },
  );
  assert.deepEqual(shape(panes.activity), [
    "#step 2",
    "assistant:正文",
    "(blank)",
    "assistant:正文二",
    "(blank)",
    "reasoning:（想）",
  ]);

  const code = buildPanes(
    [
      section([{ source: "assistant", text: "```\na\n\n\nb\n```" }], {
        turn: 1,
        step: 2,
      }),
    ],
    { level: "think" },
  );
  assert.deepEqual(shape(code.activity), ["#step 2", "code:a|||b"]);
});

test("⑦ 遮蔽标记透传到 pane 项（第 4 步据此着色）", () => {
  const panes = buildPanes(
    [
      section([{ source: "assistant", text: "被剪枝", seqs: [5] }], {
        turn: 1,
        step: 2,
      }),
    ],
    { level: "think", shadowedSeqs: new Set([5]) },
  );
  const line = panes.activity.find((item) => item.kind === "line");
  assert.equal(
    line?.kind === "line" ? line.box.shadowed === true : false,
    true,
  );
});
