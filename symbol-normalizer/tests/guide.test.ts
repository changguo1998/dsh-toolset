/**
 * 会话开局指南（guide.ts）单测：文本由 config 生成、别名映射用行内代码包裹（自身不触发审查）、
 * 每会话一次门控与容量淘汰。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GUIDE_SUMMARY,
  SymbolGuideGate,
  buildSymbolGuide,
  hasGuideMessage,
} from "../src/guide.ts";
import {
  DEFAULT_RECOMMENDED,
  maskCodeSpans,
  resolveSymbolRules,
} from "../src/symbols.ts";

test("buildSymbolGuide：含全部推荐符号与使用标准，且文本由 config 生成", () => {
  const guide = buildSymbolGuide(resolveSymbolRules({ recommended: ["§"] }));
  for (const ch of DEFAULT_RECOMMENDED) {
    assert.ok(guide.includes(ch), `白名单应含：${ch}`);
  }
  assert.ok(guide.includes("§"), "config 追加的推荐字符应出现在白名单里");
  assert.match(guide, /^\[符号规范\] 会话开局指南/);
  assert.match(guide, /禁止 emoji/);
  assert.match(guide, /行内代码与围栏代码块内的符号是引用示例/);
  assert.equal(GUIDE_SUMMARY, "符号规范（会话开局指南）");
});

test("buildSymbolGuide：别名映射取自 config 且用行内代码包裹（自身不被审查命中）", () => {
  // 用 config 覆盖内置映射：指南内容随之变化，证明文本由 config 生成
  const guide = buildSymbolGuide(
    resolveSymbolRules({ aliases: { "❌": "×" } }),
  );
  assert.ok(guide.includes("`❌→×`"), "config 覆盖后的映射应出现");
  assert.ok(!guide.includes("`❌→✗`"), "被覆盖的旧映射不应出现");
  // 掩码后指南自身没有任何可判违规的符号（证明包裹生效）
  const masked = maskCodeSpans(guide);
  for (const bad of ["❌", "✔"]) {
    assert.ok(!masked.includes(bad), `掩码后不应残留：${bad}`);
  }
});

test("buildSymbolGuide：别名映射条数有上限（正文长度可控）", () => {
  const aliases: Record<string, string> = {};
  for (let i = 0; i < 30; i += 1)
    aliases[String.fromCharCode(0x2460 + i)] = "✗";
  const guide = buildSymbolGuide(resolveSymbolRules({ aliases }));
  const line = guide.split("\n").find((l) => l.startsWith("2)"));
  assert.ok(line !== undefined);
  const pairs = (line.match(/`/g) ?? []).length / 2;
  assert.ok(pairs > 0 && pairs <= 20, `映射列出条数应受限（实际 ${pairs}）`);
});

test("SymbolGuideGate：每会话一次、按会话隔离、容量 FIFO 淘汰", () => {
  const gate = new SymbolGuideGate(2);
  assert.equal(gate.take("s1"), true, "首次 → 注入");
  assert.equal(gate.take("s1"), false, "同会话再次 → 跳过");
  assert.equal(gate.take("s2"), true, "另一会话 → 注入");
  assert.equal(gate.size(), 2);
  assert.equal(gate.take("s3"), true, "超过容量仍注入（淘汰最旧）");
  assert.equal(gate.size(), 2, "容量上限生效");
  assert.equal(gate.take("s1"), true, "最旧会话被淘汰 → 可再次注入");
});

test("hasGuideMessage：按 source.kind + summary 识别历史指南（F3）", () => {
  const guideMessage = {
    role: "user",
    content: [{ type: "text", text: "[符号规范] …" }],
    source: { kind: "rule-engine", summary: GUIDE_SUMMARY },
  };
  assert.equal(hasGuideMessage([guideMessage]), true);
  assert.equal(hasGuideMessage([]), false, "空历史 → 未注入过");
  assert.equal(
    hasGuideMessage([
      { source: { kind: "rule-engine", summary: "符号规范提醒" } },
      { source: { kind: "session-channel", summary: GUIDE_SUMMARY } },
      { role: "user" },
      null,
    ]),
    false,
    "其他摘要 / 其他来源 / 无 source 均不算命中",
  );
});

test("SymbolGuideGate.has：只读判定，不改变记账（F3 快路径用）", () => {
  const gate = new SymbolGuideGate(2);
  assert.equal(gate.has("s1"), false);
  assert.equal(gate.take("s1"), true);
  assert.equal(gate.has("s1"), true);
  assert.equal(gate.size(), 1, "has 不应新增记账");
});
