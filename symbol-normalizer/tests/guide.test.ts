/**
 * 会话开局指南（guide.ts）单测：文本由 config 生成、别名映射用行内代码包裹（自身不触发审查）、
 * 每会话一次门控与容量淘汰。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GUIDE_SUMMARY, buildSymbolGuide } from "../src/guide.ts";
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
  // 首行恰为标签（防标题 / 解释回潮）；正文恰 6 行（无额外标题 / 段落）
  assert.equal(guide.split("\n")[0], "[符号规范]");
  assert.equal(guide.split("\n").length, 6);
  assert.match(guide, /禁止 emoji/);
  assert.match(guide, /行内代码与围栏代码块内的符号不参与审查/);
  assert.equal(GUIDE_SUMMARY, "符号规范（会话开局指南）");
});

test("buildSymbolGuide：只有命令与要求（无标题、无解释性括注），且泛化规则在前", () => {
  const guide = buildSymbolGuide(resolveSymbolRules({}));
  for (const gone of [
    "会话开局指南",
    "按此输出",
    "展示层会替换",
    "几何简单",
    "无需改写",
    "不用符号凑数",
  ]) {
    assert.ok(!guide.includes(gone), `不应保留解释 / 标题：${gone}`);
  }
  // 泛化（禁止项 / 使用场景）在前，具体清单（白名单 / 变体映射 / 代码段豁免）在后；逐行锚编号
  const lines = guide.split("\n");
  assert.match(lines[1] ?? "", /^1\. 禁止 emoji/);
  assert.match(lines[2] ?? "", /^2\. 状态 \/ 方向 \/ 几何类/);
  assert.match(lines[3] ?? "", /^3\. 推荐符号白名单：/);
  assert.match(lines[4] ?? "", /^4\. 下列变体必须改用推荐符：/);
  assert.match(lines[5] ?? "", /^5\. 行内代码与围栏代码块内的符号不参与审查/);
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
  const line = guide
    .split("\n")
    .find((l) => l.startsWith("4. 下列变体必须改用推荐符"));
  assert.ok(line !== undefined);
  const pairs = (line.match(/`/g) ?? []).length / 2;
  assert.ok(pairs > 0 && pairs <= 20, `映射列出条数应受限（实际 ${pairs}）`);
});
