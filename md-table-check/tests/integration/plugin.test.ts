/**
 * 集成层: 本插件 `apply` 与宿主接线 (假 rule-engine 注册面 + 假 `assistant-text` 派发面)。
 *
 * 与单元层 `md-table-check/tests/main.test.ts` 的分工: 单元层只断注册参数与 `decide` 的两态; 这里走完整接线 ——
 * 注册 → 事件派发 → 反馈 → 按 `delivery` 投影成宿主消息, 断言送达路径、消息形状与注入正文。
 * 与 `md-table-check/tests/integration.test.ts` 的分工: 那个文件装真实的 rule-engine 插件, 这里只用假面。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FEEDBACK_SUMMARY } from "../../src/checker.ts";
import { assemble, projectedText } from "../assemble.ts";

/** 列数不一致的两行表 (分隔行少一列) */
const BAD = ["| a | b | c |", "| --- | --- |", "| 1 | 2 | 3 |"].join("\n");
/** 列数一致的两行表 */
const GOOD = ["| a | b | c |", "| --- | --- | --- |", "| 1 | 2 | 3 |"].join(
  "\n",
);
/** 两张坏表 (中间隔一行无竖线的说明行, 保证判成两张) */
const TWO_BAD = [
  "| a | b | c |",
  "| --- | --- |",
  "| 1 | 2 | 3 |",
  "中间说明",
  "| x | y | z |",
  "| --- |",
  "| 1 | 2 | 3 |",
].join("\n");

test("apply 接线: 注册一个消费者, id 与缺省四字段齐备", () => {
  const assembly = assemble();
  try {
    assert.equal(assembly.registrations.length, 1, "只注册一个消费者");
    const registered = assembly.registrations[0]!;
    assert.equal(registered.id, "md-table-check");
    assert.deepEqual(registered.sources, ["assistant-text"]);
    assert.equal(registered.delivery, "followup");
    assert.equal(registered.dedupeInRecord, 0);
    assert.equal(typeof registered.decide, "function");
    assert.equal(assembly.warnings.length, 0, "装配期无告警");
  } finally {
    assembly.dispose();
  }
});

test("apply 接线: ctx.get('ruleEngine') 回退同样完成注册", () => {
  const assembly = assemble(undefined, { surface: "get" });
  try {
    assert.equal(assembly.registrations.length, 1);
    assert.equal(assembly.emitAssistantText(BAD).length, 1);
  } finally {
    assembly.dispose();
  }
});

test("apply 接线: dispose 注销后不再派发", () => {
  const assembly = assemble();
  assert.equal(assembly.activeCount, 1);
  assembly.dispose();
  assert.equal(assembly.activeCount, 0);
  assert.equal(assembly.emitAssistantText(BAD).length, 0);
});

test("表格列数判定: 分隔行少一列 → 注入 1 次; 列数一致 → 不注入", () => {
  const assembly = assemble();
  try {
    assert.equal(assembly.emitAssistantText(BAD).length, 1, "坏表应反馈");
    assert.equal(assembly.emitAssistantText(GOOD).length, 0, "好表不反馈");
    assert.equal(assembly.emitAssistantText("纯文本回复, 没有表格").length, 0);
    assert.equal(assembly.emitAssistantText("").length, 0, "空正文不反馈");
  } finally {
    assembly.dispose();
  }
});

test("表格列数判定: 围栏内的坏表不参与判定, 闭栅后照常判定", () => {
  const assembly = assemble();
  try {
    const fenced = ["```md", "| a | b | c |", "| --- | --- |", "```"].join(
      "\n",
    );
    assert.equal(assembly.emitAssistantText(fenced).length, 0, "围栏内跳过");
    const mixed = ["~~~", "| a | b | c |", "| --- | --- |", "```"].join("\n");
    assert.equal(
      assembly.emitAssistantText(mixed).length,
      0,
      "混用栅栏也能闭合 (开 ~~~ / 闭 ```)",
    );
  } finally {
    assembly.dispose();
  }
});

test("注入内容: 提示含表头行号 / 摘录 / 期望列数 / 不一致明细 / 重发要求", () => {
  const assembly = assemble();
  try {
    const [delivery] = assembly.emitAssistantText(BAD);
    assert.ok(delivery !== undefined, "应注入 1 条");
    const text = projectedText(delivery);
    assert.match(text, /上一条回复正文里的 markdown 表格列数不一致/);
    assert.match(text, /表 1（表头在第 1 行）：`\| a \| b \| c \|` 期望 3 列/);
    assert.match(text, /第 2 行（分隔行）：2 列/);
    assert.match(text, /请修正这些表格后，把上一条回复完整重发一次/);
    assert.match(text, /不要修改仓库里的任何文件或文档/);
  } finally {
    assembly.dispose();
  }
});

test("注入内容: maxTables / maxRowsPerTable 裁剪后以「另有 N 处」收尾", () => {
  const assembly = assemble({ maxTables: 1 });
  try {
    const text = projectedText(assembly.emitAssistantText(TWO_BAD)[0]!);
    assert.equal(
      text.split("\n").filter((line) => line.startsWith("- 表 ")).length,
      1,
      "maxTables=1: 只列 1 张表",
    );
    assert.doesNotMatch(text, /表 2/, "第二张表不列出");
    assert.match(text, /另有 1 处不一致未列出。/, "未列出的 1 处要声明");
  } finally {
    assembly.dispose();
  }
  const rows = [
    "| a | b |",
    "| --- | --- |",
    "| 1 |",
    "| 2 |",
    "| 3 |",
    "| 4 |",
  ].join("\n");
  const narrowed = assemble({ maxRowsPerTable: 2 });
  try {
    const text = projectedText(narrowed.emitAssistantText(rows)[0]!);
    assert.match(text, /第 3 行（数据行）：1 列/);
    assert.match(text, /第 4 行（数据行）：1 列/);
    assert.doesNotMatch(text, /第 5 行/, "maxRowsPerTable=2: 第 3 行起不列出");
    assert.match(text, /另有 2 处不一致未列出。/, "总 4 处, 列出 2 处");
  } finally {
    narrowed.dispose();
  }
});

test("注入内容: 表头过长时摘录截到 60 个字符并加省略号", () => {
  const assembly = assemble();
  try {
    const longHeader = `| ${"x".repeat(70)} | b |`;
    const text = projectedText(
      assembly.emitAssistantText(
        [longHeader, "| --- |", "| 1 |"].join("\n"),
      )[0]!,
    );
    assert.match(text, /…` 期望 2 列/, "超长表头截断并加省略号");
    assert.doesNotMatch(
      text,
      new RegExp("x".repeat(61)),
      "摘录不超过 60 个字符",
    );
  } finally {
    assembly.dispose();
  }
});

test("output.render 投影: 注入消息的形状与 summary 齐备", () => {
  const assembly = assemble();
  try {
    const [delivery] = assembly.emitAssistantText(BAD);
    assert.ok(delivery !== undefined);
    assert.equal(delivery.via, "followup", "缺省 delivery 为 followup");
    const message = delivery.message;
    assert.equal(typeof message["id"], "string");
    assert.ok((message["id"] as string).length > 0, "消息 id 非空");
    assert.equal(message["role"], "user");
    assert.ok(Array.isArray(message["content"]), "content 为数组");
    const content = message["content"] as { type?: string; text?: string }[];
    assert.equal(content[0]?.type, "text");
    assert.ok((content[0]?.text ?? "").startsWith("[RULE] "), "正文带注入前缀");
    const source = message["source"] as
      { kind?: string; summary?: string } | undefined;
    assert.equal(source?.kind, "rule-engine", "source.kind 非空");
    assert.equal(source?.summary, FEEDBACK_SUMMARY, "source.summary 可识别");
  } finally {
    assembly.dispose();
  }
});

test("output.render 投影: delivery=steer / inject 走对应送达路径", () => {
  for (const via of ["steer", "inject"] as const) {
    const assembly = assemble({ delivery: via });
    try {
      const [delivery] = assembly.emitAssistantText(BAD);
      assert.ok(delivery !== undefined);
      assert.equal(delivery.via, via, `delivery=${via} 透传到送达路径`);
      assert.match(projectedText(delivery), /表 1（表头在第 1 行）/);
    } finally {
      assembly.dispose();
    }
  }
});

test("配置: enabled false → 仍注册但 decide 返回 null", () => {
  const assembly = assemble({ enabled: false });
  try {
    assert.equal(assembly.registrations.length, 1, "关闭时仍注册");
    assert.equal(assembly.emitAssistantText(BAD).length, 0, "关闭时不反馈");
  } finally {
    assembly.dispose();
  }
});

test("配置: sources 不含 assistant-text → 该节点不唤醒", () => {
  const assembly = assemble({ sources: ["user-message"] });
  try {
    assert.deepEqual(assembly.registrations[0]!.sources, ["user-message"]);
    assert.equal(assembly.emitAssistantText(BAD).length, 0, "别的节点不唤醒");
  } finally {
    assembly.dispose();
  }
});

test("rule-engine 缺席: 不注册, 告警写 stderr, dispose 可调用", () => {
  const assembly = assemble(undefined, { surface: "absent" });
  assert.equal(assembly.registrations.length, 0, "缺席时不注册");
  assert.ok(
    assembly.warnings.some((line) => line.includes("ctx.ruleEngine 不可用")),
    "应写缺席告警",
  );
  assert.equal(assembly.emitAssistantText(BAD).length, 0);
  assembly.dispose();
});
