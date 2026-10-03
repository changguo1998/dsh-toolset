// tests/tool-meta.test.ts — tool/result.meta 行级 diff 摘要纯函数（宽容解析 + 降级）
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolResultLine } from "../src/app/layout/tool-line.ts";
import { initialState, reduceState } from "../src/app/state.ts";

test("toolResultLine：before/after 字符串 → 追加 (+N/-M)", () => {
  // before a,x → after a,y：added=y, removed=x
  assert.equal(
    toolResultLine(true, "ok", { before: "a\nx", after: "a\ny" }),
    "✓ ok (+1/-1)",
  );
  // 纯新增行
  assert.equal(
    toolResultLine(true, "ok", { before: "a\nb", after: "a\nb\nc" }),
    "✓ ok (+1/-0)",
  );
});

test("toolResultLine：失败分支也带 diff 摘要", () => {
  assert.equal(
    toolResultLine(false, "boom", { before: "a\nb", after: "a\nc" }),
    "✗ boom (+1/-1)",
  );
});

test("toolResultLine：无 meta / 异形 / 零变化 → 不追加摘要（降级）", () => {
  assert.equal(toolResultLine(true, "ok", undefined), "✓ ok");
  assert.equal(toolResultLine(true, "ok", { foo: 1 }), "✓ ok");
  assert.equal(toolResultLine(true, "ok", { before: 1, after: "x" }), "✓ ok");
  assert.equal(toolResultLine(true, "ok", { before: "a", after: "a" }), "✓ ok");
  // 空 detail：成功只出 `✓ `（空段省略）；失败走兜底文案；两者都不再加「（无结果）」占位
  assert.equal(
    toolResultLine(true, "", { before: "a", after: "a\nb" }),
    "✓ (+1/-0)",
  );
  assert.equal(toolResultLine(true, ""), "✓ ", "成功空 detail 不加占位");
  assert.equal(toolResultLine(true, "ok"), "✓ ok");
  assert.equal(
    toolResultLine(false, ""),
    "✗ 输出错误",
    "失败空 detail 走兜底文案",
  );
  assert.equal(toolResultLine(false, "EACCES: 13"), "✗ EACCES: 13");
  assert.equal(
    toolResultLine(false, "", { before: "a", after: "b" }),
    "✗ 输出错误 (+1/-1)",
  );
  // 前缀契约：空 detail 的成功行仍以 `✓ ` 开头（content-rules 按符号判定，勿 trimEnd）
  assert.ok(
    toolResultLine(true, "").startsWith("✓ "),
    "前缀契约：`✓ ` 尾随空格",
  );
});

test("toolResultLine：meta 全量不入 buffer（仅摘要）", () => {
  const big = { before: "x".repeat(5000), after: "y".repeat(5000) };
  const line = toolResultLine(true, "ok", big);
  assert.ok(line.length < 64, "摘要行必须短小，绝不外喷全文");
  assert.ok(!line.includes("xxxx") && !line.includes("yyyy"));
});

test("reduceState：model-selection → modelBySession 按会话隔离（宽容字段）", () => {
  let st = reduceState(initialState(), {
    type: "model-selection",
    sessionId: "a",
    provider: "ustc",
    model: "v4-flash",
    reasoningEffort: "high",
  });
  assert.equal(st.modelBySession["a"]?.model, "v4-flash");
  assert.equal(st.modelBySession["a"]?.reasoningEffort, "high");
  st = reduceState(st, {
    type: "model-selection",
    sessionId: "b",
    provider: "q",
    model: "n",
  });
  assert.equal(st.modelBySession["a"]?.provider, "ustc"); // a 会话不受 b 影响
  assert.equal(st.modelBySession["b"]?.reasoningEffort, undefined); // 缺省宽容
});
