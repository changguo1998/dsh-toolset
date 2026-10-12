// tests/tool-meta.test.ts — 工具行展示纯函数（tool/result.meta 行级 diff 摘要：
// 宽容解析 + 降级；以及显示期工作区根前缀缩短 `shortenWorkspacePath`）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shortenWorkspacePath,
  toolCallLine,
  toolResultLine,
} from "../src/app/layout/tool-line.ts";
import { buildApprovalPrompt } from "../src/app/adapter/normalize.ts";
import {
  allSections,
  applyAll,
  createSections,
} from "../src/app/layout/pipeline/sections.ts";
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

test("流水线：工具结果交付带 meta → 节模型透传 → 结果行含 diff 摘要", () => {
  // 六步流水线上 `rows.ts` 就是这么取 meta 的（`toolResultLine(ok, detail, result.meta)`）：
  // 交付不带 meta 时这一层拿不到 before/after，摘要永远不显示（BACKLOG〈演示冒烟现状〉②）
  const meta = { before: "a\nb", after: "a\nb\nc" };
  const state = applyAll(createSections(), [
    {
      kind: "tool-call",
      turn: 1,
      step: 1,
      callId: "c1",
      name: "write",
      args: "{}",
    },
    {
      kind: "tool-result",
      turn: 1,
      step: 1,
      callId: "c1",
      ok: true,
      detail: "已写入",
      meta,
    },
  ]);
  const result = allSections(state)
    .flatMap((section) => section.items)
    .flatMap((item) => item.results ?? [])[0];
  assert.deepEqual(result?.meta, meta, "交付的 meta 透传到节模型的 ToolResult");
  assert.equal(
    toolResultLine(result?.ok ?? false, result?.detail ?? "", result?.meta),
    "✓ 已写入 (+1/-0)",
    "结果行按 ToolResult.meta 渲染出 diff 摘要",
  );
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

// —— 显示期路径缩短（工作区根前缀） ——

const ROOT = "/home/u/proj";

test("shortenWorkspacePath：根 + 斜杠 → 相对路径；裸根 → `.`", () => {
  assert.equal(
    shortenWorkspacePath(ROOT + "/TUI/src/x.ts", ROOT),
    "TUI/src/x.ts",
  );
  assert.equal(
    shortenWorkspacePath("cd " + ROOT + " && ls", ROOT),
    "cd . && ls",
  );
  assert.equal(shortenWorkspacePath("read " + ROOT, ROOT), "read .");
  assert.equal(
    shortenWorkspacePath('--path "' + ROOT + '/a b"', ROOT),
    '--path "a b"',
    "引号后也算路径起点",
  );
});

test("shortenWorkspacePath：同前缀兄弟目录 / 非路径起点 / 空根 → 不动", () => {
  // `<根>-extra` 是兄弟目录，不是工作区内路径
  assert.equal(
    shortenWorkspacePath(ROOT + "-extra/x", ROOT),
    ROOT + "-extra/x",
  );
  // 根出现在长串中间（前面不是路径起点）→ 不动
  assert.equal(
    shortenWorkspacePath("x" + ROOT + "/a", ROOT),
    "x" + ROOT + "/a",
  );
  // 根为空 / `/` → 原样返回（避免无意义全局替换）
  assert.equal(shortenWorkspacePath("/a/b", ""), "/a/b");
  assert.equal(shortenWorkspacePath("/a/b", "/"), "/a/b");
  // 尾斜杠书写等价
  assert.equal(shortenWorkspacePath(ROOT + "/a", ROOT + "/"), "a");
});

test("toolCallLine / toolResultLine：展示时省掉工作区根前缀（缺省取进程 cwd）", () => {
  const cwd = process.cwd();
  assert.equal(
    toolCallLine("read", cwd + "/TUI/src/x.ts"),
    "read TUI/src/x.ts",
  );
  assert.equal(toolCallLine("bash", "cd " + cwd + " && ls"), "bash cd . && ls");
  assert.equal(
    toolResultLine(true, cwd + "/TUI/src/x.ts", { before: "a", after: "a\nb" }),
    "✓ TUI/src/x.ts (+1/-0)",
    "结果 detail 同样缩短，diff 摘要照旧",
  );
  // 与工作区无关的路径原样保留
  assert.equal(toolCallLine("read", "/etc/hosts"), "read /etc/hosts");
});

test("buildApprovalPrompt：命令/参数里的工作区根前缀同样缩短（仅显示）", () => {
  const cwd = process.cwd();
  const prompt = buildApprovalPrompt(
    { agent: null, toolName: "bash", callId: "c1" },
    { tool: "bash", command: "cd " + cwd + " && npm test" },
  );
  assert.ok(prompt.includes("命令："), "保留命令段: " + prompt);
  assert.ok(prompt.includes("cd . && npm test"), "命令内路径已缩短: " + prompt);
  assert.ok(!prompt.includes(cwd), "不再出现工作区绝对路径: " + prompt);
  // 无明细 → 单行旧文案（reason 原样）
  const single = buildApprovalPrompt({
    agent: null,
    toolName: "bash",
    reason: "写 " + cwd + "/a.txt",
  });
  assert.equal(single, "允许工具 bash 执行?：写 a.txt");
});
