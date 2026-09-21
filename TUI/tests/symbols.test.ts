/**
 * 模型输出符号规范化（symbols.ts）纯函数测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RECOMMENDED,
  normalizeSymbols,
  resolveSymbolRules,
} from "../src/app/symbols.ts";

test("resolveSymbolRules：内置默认白名单与 warnModel", () => {
  const rules = resolveSymbolRules();
  for (const s of DEFAULT_RECOMMENDED) {
    assert.ok(rules.recommendedSet.has(s), `内置推荐 ${s} 存在`);
  }
  assert.equal(rules.warnModel, true);
  assert.equal(rules.aliases["✖"], "✗");
  // 箭头家族选型（2026-09-21）：单线四向全推荐（A→），B→▶、C→⟹、D 不纳入
  for (const s of ["→", "←", "↑", "↓", "↔"]) {
    assert.ok(rules.recommendedSet.has(s), `方向箭头 ${s} 已推荐`);
  }
  assert.ok(rules.recommendedSet.has("▶"), "家族 B 代表 ▶");
  assert.ok(rules.recommendedSet.has("⟹"), "家族 C 代表 ⟹");
  // 三角箭头四向全推荐（与 ▶ 同风格）；方块、菱形也推荐
  for (const s of ["▶", "◀", "▲", "▼"]) {
    assert.ok(rules.recommendedSet.has(s), `三角方向 ${s} 已推荐`);
  }
  for (const s of ["■", "□", "◇", "◆"]) {
    assert.ok(rules.recommendedSet.has(s), `几何 ${s} 已推荐`);
  }
  // 加减：归一到 ASCII（优先 ASCII）
  assert.equal(rules.aliases["➕"], "+", "➕ → +");
  assert.equal(rules.aliases["➖"], "-", "➖ → -");
  // 金额：全角 ￥ 归一半角 ¥
  assert.equal(rules.aliases["￥"], "¥", "￥ → ¥");
  // 列表域（圆点族代表 •；☑√☒ 等按几何拆分，见 DEFAULT_ALIASES 后说明）
  // 圆域定稿（2026-09-21）：空心点/实心点/空圈/实心圆/大空圈 全推荐（均为圆几何）
  for (const s of ["•", "◦", "○", "●", "◯"]) {
    assert.ok(rules.recommendedSet.has(s), `圆域 ${s} 已推荐`);
  }
  assert.ok(rules.recommendedSet.has("〜"), "〜（U+301C，2 列）波浪推荐");
  assert.equal(rules.aliases["～"], "〜", "～（全角）→ 〜");
  // 星标域：全域不纳入（★☆✦✧ 与 emoji ⭐ 均不推荐）
  for (const s of ["★", "☆", "✦", "✧", "⭐"]) {
    assert.ok(!rules.recommendedSet.has(s), `${s} 不推荐`);
    assert.equal(rules.aliases[s], undefined, `${s} 无别名`);
  }
  // 信息域：圈 i 代表 ⓘ（ℹ→ⓘ 族内归一）；感叹族推荐 ASCII `!`（❗❕→!）；图形族不纳入
  assert.ok(rules.recommendedSet.has("ⓘ"), "ⓘ 为圈 i 族代表");
  assert.equal(rules.aliases["ℹ"], "ⓘ", "ℹ → ⓘ");
  assert.equal(rules.aliases["❗"], "!", "❗ → !");
  assert.equal(rules.aliases["❕"], "!", "❕ → !");
  assert.equal(rules.aliases["💡"], undefined, "💡 不纳入（无别名）");
});

test("按几何拆分的符号：不再归一 → 各自独立（使用即提醒/放行）", () => {
  const rules = resolveSymbolRules();
  // 拆分项无别名（√ 在治理区外自然放行，其余在治理区内会提醒）
  for (const s of ["☑", "☒", "⇔", "⇐", "√"]) {
    assert.equal(rules.aliases[s], undefined, `${s} 已拆分、无别名`);
  }
  const r = normalizeSymbols("☑ 勾 ☒ 叉 ◦ 放行 ⇔ 双向 ⇐ 反向 √ 根号 ✓", rules);
  assert.equal(r.replacedCount, 0, "拆分项不替换");
  assert.equal(r.text, "☑ 勾 ☒ 叉 ◦ 放行 ⇔ 双向 ⇐ 反向 √ 根号 ✓");
  // 治理区内拆分项记提醒；◦（已推荐放行）与 √（治理区外）不提醒
  assert.deepEqual(
    r.unrecommended,
    ["☑", "☒", "⇔", "⇐"],
    "治理区内的拆分项使用即提醒（◦ 已推荐、√ 治理区外除外）",
  );
  // 保留归一项不受影响
  assert.equal(rules.aliases["✅"], "✓", "✅ 保留归一");
  assert.equal(rules.aliases["×"], "✗", "× 保留归一");
  assert.equal(rules.aliases["⚠"], "△", "⚠ 保留归一");
  assert.equal(rules.aliases["⏩"], "▶", "⏩ 保留归一");
});

test("圆域全推荐放行、全角波浪归一到 U+301C", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols("○ 空 ● 实 ◦ 点 ◯ 大 〜 波 ～ 全", rules);
  assert.equal(r.replacedCount, 1);
  assert.equal(r.text, "○ 空 ● 实 ◦ 点 ◯ 大 〜 波 〜 全");
  assert.deepEqual(r.unrecommended, []);
});

test("三角箭头四向、方块、菱形全放行；键盘键不推荐", () => {
  const rules = resolveSymbolRules();
  const geo = normalizeSymbols("◀ ▲ ▼ ■ □ ◇ ◆", rules);
  assert.equal(geo.replacedCount, 0);
  assert.deepEqual(geo.unrecommended, []);
  // 键盘键（如 ⌘ 起等）不推荐：⌘ 在治理区外天然放行（不提醒），此处验证无推荐/无别名
  assert.equal(rules.aliases["⌘"], undefined);
  assert.ok(!rules.recommendedSet.has("⌘"));
});

test("方向箭头四向放行、加减归一 ASCII、带圈数字（复合几何）提醒", () => {
  const rules = resolveSymbolRules();
  // 四向单线箭头（→←↑↓↔）全部放行
  const dir = normalizeSymbols("上 ↑ 下 ↓ 左 ← 右 → 交换 ↔", rules);
  assert.equal(dir.replacedCount, 0);
  assert.deepEqual(dir.unrecommended, []);
  // 加减 → ASCII
  const arith = normalizeSymbols("➕ 增 ➖ 减", rules);
  assert.equal(arith.text, "+ 增 - 减");
  assert.equal(arith.replacedCount, 2);
  assert.deepEqual(arith.unrecommended, []);
  // 带圈数字：复合几何不归一不推荐 → 使用即提醒（指导用 ASCII 序号）
  const seq = normalizeSymbols("步骤 ❶ 再 ❷", rules);
  assert.equal(seq.replacedCount, 0);
  assert.equal(seq.text, "步骤 ❶ 再 ❷");
  assert.deepEqual(seq.unrecommended, ["❶", "❷"]);
  // 金额：￥ 归一为 ¥（¥ 治理区外，不触发提醒）
  const money = normalizeSymbols("价格 ￥100 元", rules);
  assert.equal(money.text, "价格 ¥100 元");
  assert.equal(money.replacedCount, 1);
  assert.deepEqual(money.unrecommended, []);
});

test("信息域：圈 i/感叹归一、灯泡使用即提醒", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols("ℹ 提示 ❗ 小心 💡 主意", rules);
  assert.equal(r.replacedCount, 2);
  assert.equal(r.text, "ⓘ 提示 ! 小心 💡 主意");
  assert.deepEqual(r.unrecommended, ["💡"], "灯泡（图形族未纳入）记提醒");
});

test("星标域：全域不纳入 → 使用即提醒、展示层不改动", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols("★ 重点 ☆ ✦ ⭐ emoji", rules);
  assert.equal(r.replacedCount, 0);
  assert.equal(r.text, "★ 重点 ☆ ✦ ⭐ emoji");
  assert.deepEqual(
    r.unrecommended,
    ["★", "☆", "✦", "⭐"],
    "星标字符（含带颜色的 emoji ⭐）原样保留并记提醒",
  );
});

test("aliases：变体叉/勾/乘号 → 推荐符号（替换 + 计数 + 明细）", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols("✔ 好 ✖ 坏 ❌ 停 ✅ 成 × 错", rules);
  assert.equal(r.text, "✓ 好 ✗ 坏 ✗ 停 ✓ 成 ✗ 错");
  assert.equal(r.replacedCount, 5);
  assert.deepEqual(r.unrecommended, []);
  assert.ok(r.remaps.some((m) => m.from === "❌" && m.to === "✗"));
});

test("无替代符号：保留原文并记 unrecommended（去重、按序）", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols("火箭 🚀 大脑 🧠 ❤ 再 🚀", rules);
  assert.equal(r.text, "火箭 🚀 大脑 🧠 ❤ 再 🚀"); // 展示层不改动
  assert.equal(r.replacedCount, 0);
  assert.deepEqual(r.unrecommended, ["🚀", "🧠", "❤"], "去重且按出现顺序");
});

test("推荐符号 / 文字 / 常用标点不触发", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols("✓ 完成 ✗ 失败 △ 注意 中文字符，标点…", rules);
  assert.equal(r.replacedCount, 0);
  assert.deepEqual(r.unrecommended, []);
  assert.equal(r.text, "✓ 完成 ✗ 失败 △ 注意 中文字符，标点…");
});

test("配置扩展：extraRecommended 放行、aliases 覆盖内置", () => {
  const rules = resolveSymbolRules({
    recommended: ["🚀"],
    aliases: { "❤": "heart" },
  });
  const r = normalizeSymbols("🚀 ❤ ⚠", rules);
  assert.equal(r.replacedCount, 2); // ❤→heart、⚠→△（默认别名）
  assert.equal(r.text, "🚀 heart △");
  assert.deepEqual(r.unrecommended, []);
});

test("非治理区（拉丁字母/希腊字母等）默认放行", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols("café Ω = 3.14 · 半角", rules);
  assert.equal(r.replacedCount, 0);
  assert.deepEqual(r.unrecommended, []);
});

test("README 建议的 ✓/✗/△ 与文字替代在 aliases 内可用", () => {
  const rules = resolveSymbolRules();
  // 仍保留归一的变体（☑/√/☒ 已拆分，另行断言）
  for (const from of ["✔", "✅"]) {
    assert.equal(rules.aliases[from], "✓", `${from} → ✓`);
  }
  for (const from of ["✕", "✖", "✘", "❌", "×", "🗙"]) {
    assert.equal(rules.aliases[from], "✗", `${from} → ✗`);
  }
  assert.equal(rules.aliases["⚠"], "△", "⚠ → △（填色三角换细线空心三角）");
  // 箭头家族族内归一：A 线条 → →；B 三角 → ▶；C 双线（同向右）→ ⟹（⇔⇐ 已拆分）
  for (const from of ["➔", "➜", "➡"]) {
    assert.equal(rules.aliases[from], "→", `${from} → →`);
  }
  for (const from of ["▸", "►", "⏵", "⏩", "➤"]) {
    assert.equal(rules.aliases[from], "▶", `${from} → ▶`);
  }
  assert.equal(rules.aliases["⇒"], "⟹", "⇒ → ⟹");
  assert.equal(rules.aliases["⇔"], undefined, "⇔ 已拆分");
  assert.equal(rules.aliases["⇐"], undefined, "⇐ 已拆分");
});

test("箭头家族：推荐放行、族内别名归一、D 族（未纳入）触发提醒", () => {
  const rules = resolveSymbolRules();
  // 推荐代表放行
  const pass = normalizeSymbols("一 → 二 ▶ 三 ⟹ 四", rules);
  assert.equal(pass.replacedCount, 0);
  assert.deepEqual(pass.unrecommended, []);
  // 族内变体 → 归一到代表（▶ 是代表，不计替换）；D 族 ⇢ 未纳入 → 记提醒
  const remap = normalizeSymbols("➡ ⏩ ⇒ ▸ ▶ ⇢", rules);
  assert.equal(remap.replacedCount, 4); // ➡→→、⏩→▶、⇒→⟹、▸→▶
  assert.equal(remap.text, "→ ▶ ⟹ ▶ ▶ ⇢");
  assert.deepEqual(remap.unrecommended, ["⇢"], "D 族未纳入：保留原文并提醒");
});
