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
  // 箭头家族选型（2026-09-21）：单线八向 + 双向（↔↕）全推荐（A→），B→▶、C→⟸⟹⟺、D 不纳入
  for (const s of ["→", "←", "↑", "↓", "↔", "↕", "↖", "↗", "↘", "↙"]) {
    assert.ok(rules.recommendedSet.has(s), `方向箭头 ${s} 已推荐`);
  }
  assert.ok(rules.recommendedSet.has("▶"), "家族 B 代表 ▶");
  for (const s of ["⟸", "⟹", "⟺"]) {
    assert.ok(rules.recommendedSet.has(s), `家族 C 代表 ${s}`);
  }
  // 三角箭头四向全推荐（与 ▶ 同风格）；方块、菱形也推荐
  for (const s of ["▶", "◀", "▲", "▼"]) {
    assert.ok(rules.recommendedSet.has(s), `三角方向 ${s} 已推荐`);
  }
  // 空心三角族四向代表（2026-11）：▷◁△▽ 各成一族、族内归一（与实心不互相归一）
  for (const s of ["▷", "◁", "△", "▽"]) {
    assert.ok(rules.recommendedSet.has(s), `空心三角方向 ${s} 已推荐`);
  }
  for (const s of ["■", "□", "◇", "◆"]) {
    assert.ok(rules.recommendedSet.has(s), `几何 ${s} 已推荐`);
  }
  // 加减：归一到 ASCII（优先 ASCII）
  assert.equal(rules.aliases["➕"], "+", "➕ → +");
  assert.equal(rules.aliases["➖"], "-", "➖ → -");
  // 金额：全角 ￥ 归一半角 ¥
  assert.equal(rules.aliases["￥"], "¥", "￥ → ¥");
  // 状态域（2026-11）：☑/☒ 为「有框勾/叉」特例，并入无框的 ✓/✗；✅→✓；☑ 不入白名单
  assert.ok(!rules.recommendedSet.has("☑"), "☑（方框勾）不单独推荐");
  assert.equal(rules.aliases["✅"], "✓", "✅ → ✓（方框勾 emoji → 细线勾）");
  assert.equal(rules.aliases["☑"], "✓", "☑（方框勾）→ ✓");
  assert.equal(rules.aliases["☒"], "✗", "☒（方框叉）→ ✗");
  assert.equal(rules.aliases["✔"], "✓", "✔ → ✓（细线勾）");
  // 方块族（2026-11）：空心尺寸变体 → □、实心尺寸变体 → ■、方块 emoji 纯色 → ■
  //   ◽（U+25FD 观感实心）归 ■、🔲（黑方块按钮=双色边框）归 □（2026-11 订正）
  for (const from of ["▫", "◻", "🔳", "🔲"]) {
    assert.equal(
      rules.aliases[from],
      "□",
      `${from} → □（空心，含白/黑方块按钮 🔳🔲）`,
    );
  }
  for (const from of ["◽", "▪", "◼", "⬛", "⬜", "🟨"]) {
    assert.equal(rules.aliases[from], "■", `${from} → ■（纯色/观感实心）`);
  }
  // 菱形族归一（2026-11）：emoji 纯色（🔷🔹🔶🔸）与实心文本变体 → ◆；空心文本变体 → ◇
  for (const [from, to] of [
    ["🔷", "◆"],
    ["🔹", "◆"],
    ["🔶", "◆"],
    ["🔸", "◆"],
    ["⬥", "◆"],
    ["⬧", "◆"],
    ["⬦", "◇"],
    ["⬨", "◇"],
  ] as const) {
    assert.equal(rules.aliases[from], to, `${from} → ${to}`);
  }
  // 三角族 emoji 归一（2026-11）：🔺🔼→▲、🔻🔽→▼
  for (const [from, to] of [
    ["🔺", "▲"],
    ["🔼", "▲"],
    ["🔻", "▼"],
    ["🔽", "▼"],
  ] as const) {
    assert.equal(rules.aliases[from], to, `${from} → ${to}`);
  }
  // 圆域定稿（2026-09-21）+ 空心/实心分族（2026-11）：空心点/实心点/空圈/实心圆/大空圈 全推荐（均为圆几何）
  for (const s of ["•", "◦", "○", "●", "◯"]) {
    assert.ok(rules.recommendedSet.has(s), `圆域 ${s} 已推荐`);
  }
  // 圆族 emoji 归一（2026-11）：纯色（含 ⚪ 白）→ ●；仅 ⭕（圆环，内空腔）→ ○
  for (const [from, to] of [
    ["⚪", "●"],
    ["⭕", "○"],
    ["⚫", "●"],
    ["🔴", "●"],
    ["🟣", "●"],
  ] as const) {
    assert.equal(rules.aliases[from], to, `${from} → ${to}`);
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
  // 拆分项无别名（√ 治理区外放行、◦ 白名单放行；☑☒ 为特例归一，另测）
  assert.equal(rules.aliases["√"], undefined, "√ 已拆分、无别名");
  const r = normalizeSymbols("☑ 特例 ☒ 特例 ◦ 放行 √ 根号 ✓", rules);
  assert.equal(r.replacedCount, 2, "☑☒ 特例归一替换 2 处");
  assert.equal(r.text, "✓ 特例 ✗ 特例 ◦ 放行 √ 根号 ✓");
  // ◦/✓（白名单放行）与 √（治理区外）不提醒
  assert.deepEqual(
    r.unrecommended,
    [],
    "√ 治理区外、◦✓ 白名单放行、☑☒ 特例归一，均不提醒",
  );
  // 保留归一项不受影响
  assert.equal(rules.aliases["✅"], "✓", "✅ → ✓（方框勾 emoji）");
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

test("圆族 emoji 归一：纯色（含 ⚪ 白）→ ●、仅 ⭕（圆环）→ ○；空心/实心分族不互相归一", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols("⭕ 圈 ⚪ 白 ⚫ 黑 🔴 红 🟠 橙 🟣 紫", rules);
  assert.equal(r.replacedCount, 6);
  assert.equal(r.text, "○ 圈 ● 白 ● 黑 ● 红 ● 橙 ● 紫");
  assert.deepEqual(r.unrecommended, []);
  // 空心/实心分族（2026-11）：▷ 为空心右三角代表（已推荐放行）；▹→▷ 族内归一
  const tri = normalizeSymbols("实心 ▶ 空心 ▷ 小空 ▹ 上传 ▲ 下空 ▽", rules);
  assert.equal(tri.replacedCount, 1);
  assert.equal(tri.text, "实心 ▶ 空心 ▷ 小空 ▷ 上传 ▲ 下空 ▽");
  assert.deepEqual(tri.unrecommended, []);
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
  // 四向单线 + 对角 + 双向（↕）箭头全部放行
  const dir = normalizeSymbols(
    "上 ↑ 下 ↓ 左 ← 右 → 交换 ↔ 上下 ↕ 斜 ↗ 斜 ↙",
    rules,
  );
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
  // emoji 起源单独记录（✅❌ 在列；✔✖× 细线变体不在列）
  assert.equal(
    r.emojiRemaps.map((m) => m.from).join(""),
    "❌✅",
    "emojiRemaps 只含 emoji 呈现起源的替换",
  );
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
  // 勾：✔→✓（细线）、✅→✓（方框勾 emoji）、☑→✓（方框勾特例）；叉：…→✗、☒→✗；√ 已拆分
  assert.equal(rules.aliases["✔"], "✓", "✔ → ✓");
  assert.equal(rules.aliases["✅"], "✓", "✅ → ✓");
  assert.equal(rules.aliases["☑"], "✓", "☑ → ✓");
  for (const from of ["✕", "✖", "✘", "❌", "×", "🗙", "☒"]) {
    assert.equal(rules.aliases[from], "✗", `${from} → ✗`);
  }
  assert.equal(rules.aliases["⚠"], "△", "⚠ → △（填色三角换细线空心三角）");
  // 箭头家族族内归一：A 线条 → →；B 三角 → ▶；C 双线（按方向）→ ⟸⟹⟺
  for (const from of ["➔", "➜", "➡"]) {
    assert.equal(rules.aliases[from], "→", `${from} → →`);
  }
  for (const from of ["⬅", "⬆", "⬇"]) {
    assert.equal(
      rules.aliases[from],
      { "⬅": "←", "⬆": "↑", "⬇": "↓" }[from],
      `${from} → 同向细线箭头`,
    );
  }
  for (const from of ["▸", "►", "⏵", "⏩", "➤"]) {
    assert.equal(rules.aliases[from], "▶", `${from} → ▶`);
  }
  for (const from of ["◂", "◄", "⏴", "⏪"]) {
    assert.equal(rules.aliases[from], "◀", `${from} → ◀`);
  }
  for (const from of ["▴", "⏶"]) {
    assert.equal(rules.aliases[from], "▲", `${from} → ▲`);
  }
  for (const from of ["▾", "⏷"]) {
    assert.equal(rules.aliases[from], "▼", `${from} → ▼`);
  }
  assert.equal(rules.aliases["⇒"], "⟹", "⇒ → ⟹");
  assert.equal(rules.aliases["⇐"], "⟸", "⇐ → ⟸（左向双线按方向归一）");
  assert.equal(rules.aliases["⇔"], "⟺", "⇔ → ⟺（双向双线按方向归一）");
  // 空心三角族内归一（2026-11）：▹▻→▷、◃◅→◁、▵→△、▿→▽
  for (const [from, to] of [
    ["▹", "▷"],
    ["▻", "▷"],
    ["◃", "◁"],
    ["◅", "◁"],
    ["▵", "△"],
    ["▿", "▽"],
  ] as const) {
    assert.equal(rules.aliases[from], to, `${from} → ${to}`);
  }
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
  // 方向一致（2026-11）：左/上/下黑箭头与三角变体归一到同向推荐
  const dir = normalizeSymbols(
    "⬅ 左 ⬆ 上 ⬇ 下 ◂ 左三 ▴ 上三 ⏶ 中上 ⏷ 中下",
    rules,
  );
  assert.equal(dir.replacedCount, 7);
  assert.equal(dir.text, "← 左 ↑ 上 ↓ 下 ◀ 左三 ▲ 上三 ▲ 中上 ▼ 中下");
  assert.deepEqual(dir.unrecommended, []);
  // 媒体三角 ⏴⏪⏶⏷ 属 emoji 呈现起源（同 ⏵⏩）；文本三角 ◂▴ 不记
  assert.equal(
    dir.emojiRemaps.map((m) => m.from).join(""),
    "⏶⏷",
    "⏴⏪⏶⏷ 媒体三角按 emoji 要求更换",
  );
  // C 族按方向归一（2026-11）：⇒→⟹、⇐→⟸、⇔→⟺（⟸⟹⟺ 已推荐放行）
  const cdir = normalizeSymbols(
    "⟺ 双向 ⟸ 反向 ⟹ 正向 ⇒ 推导 ⇐ 左 ⇔ 互换",
    rules,
  );
  assert.equal(cdir.replacedCount, 3);
  assert.equal(cdir.text, "⟺ 双向 ⟸ 反向 ⟹ 正向 ⟹ 推导 ⟸ 左 ⟺ 互换");
  assert.deepEqual(cdir.unrecommended, []);
  // 空心三角族内归一（2026-11）：▹▻→▷、◃◅→◁、▵→△、▿→▽（▷◁△▽ 已推荐放行）
  const hollow = normalizeSymbols(
    "▹ 右小 ▻ 右指 ◃ 左小 ◅ 左指 ▵ 上小 ▿ 下小",
    rules,
  );
  assert.equal(hollow.replacedCount, 6);
  assert.equal(hollow.text, "▷ 右小 ▷ 右指 ◁ 左小 ◁ 左指 △ 上小 ▽ 下小");
  assert.deepEqual(hollow.unrecommended, []);
});

test("方块族归一：空心尺寸变体 → □、实心/纯色 → ■（含白大方 ⬜）、双色方块按钮 → □", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols(
    "▫ 点 ◻ 中 ⬜ 大 ▪ 实 ◼ 中 ⬛ 大 🟨 黄 🔳 白钮 🔲 黑钮 ◽ 小实",
    rules,
  );
  assert.equal(r.replacedCount, 10);
  assert.equal(
    r.text,
    "□ 点 □ 中 ■ 大 ■ 实 ■ 中 ■ 大 ■ 黄 □ 白钮 □ 黑钮 ■ 小实",
  );
  assert.deepEqual(r.unrecommended, []);
  // 方块 emoji（⬜⬛🟨🔳🔲 等 emoji 呈现）记入 emojiRemaps（要求更换）；▫◻◽▪◼ 等细线变体不记
  assert.equal(
    r.emojiRemaps.map((m) => m.from).join(""),
    "⬜⬛🟨🔳🔲",
    "方块 emoji 属 emoji 呈现起源（🔲 黑方块按钮同属）",
  );
  // 圆角空心方块 ▢ 属不同几何 → 仍提醒
  const deg = normalizeSymbols("圆角 ▢ 方块", rules);
  assert.deepEqual(deg.unrecommended, ["▢"], "▢ 圆角方块独立、使用即提醒");
});

test("菱形/三角 emoji 归一：emoji 纯色 → ◆（🔶🔸🔷🔹）、空心文本变体 → ◇（⬦⬨）、🔺🔼→▲、🔻🔽→▼", () => {
  const rules = resolveSymbolRules();
  const r = normalizeSymbols(
    "◇ 空 ◆ 实 🔶 橙 🔷 蓝 ⬥ 中实 ⬦ 中空 🔺 上 🔻 下 🔼 小上 🔽 小下",
    rules,
  );
  assert.equal(r.replacedCount, 8);
  assert.equal(
    r.text,
    "◇ 空 ◆ 实 ◆ 橙 ◆ 蓝 ◆ 中实 ◇ 中空 ▲ 上 ▼ 下 ▲ 小上 ▼ 小下",
  );
  assert.deepEqual(r.unrecommended, []);
  // 菱形/三角 emoji 均属 emoji 呈现起源 → 记入 emojiRemaps（要求更换）；⬥⬦ 文本变体不记
  assert.equal(
    r.emojiRemaps.map((m) => m.from).join(""),
    "🔶🔷🔺🔻🔼🔽",
    "菱形/三角 emoji 按 emoji 要求更换（文本尺寸变体只替换不计 emoji）",
  );
});

test("举一反三扩展（2026-11）：⏫⏬ 媒体双三角、🗸🗹🗷 勾叉扩展、❓❔→?、⬤→●、￠￡→半角、➠➢➣→→", () => {
  const rules = resolveSymbolRules();
  // 别名断言
  assert.equal(rules.aliases["⏫"], "▲", "⏫ → ▲（双三角=数量修饰，同 ⏩）");
  assert.equal(rules.aliases["⏬"], "▼", "⏬ → ▼");
  assert.equal(rules.aliases["🗸"], "✓", "🗸 → ✓");
  assert.equal(rules.aliases["🗹"], "✓", "🗹 → ✓（方框勾特例，同 ☑）");
  assert.equal(rules.aliases["🗷"], "✗", "🗷 → ✗（方框叉特例，同 ☒）");
  assert.equal(rules.aliases["❓"], "?", "❓ → ?");
  assert.equal(rules.aliases["❔"], "?", "❔ → ?");
  assert.equal(rules.aliases["⬤"], "●", "⬤ → ●（同形状仅大小=修饰）");
  assert.equal(rules.aliases["￠"], "¢", "￠ → ¢（全角→半角）");
  assert.equal(rules.aliases["￡"], "£", "￡ → £（全角→半角）");
  assert.equal(rules.aliases["￦"], "₩", "￦ → ₩（全角→半角，FFE6 金额系列）");
  for (const from of ["➠", "➢", "➣"]) {
    assert.equal(rules.aliases[from], "→", `${from} → →（方向一致）`);
  }
  // normalize：替换计数、文本、emojiRemaps（⬤➠➢➣￠￡ 为文本/全角，不入 emojiRemaps）
  const r = normalizeSymbols(
    "⏫ 上 ⏬ 下 🗸 勾 🗹 框勾 🗷 框叉 ❓ 问 ❔ 问 ⬤ 圆 ￡ 镑 ➠ 箭头",
    rules,
  );
  assert.equal(r.replacedCount, 10);
  assert.equal(
    r.text,
    "▲ 上 ▼ 下 ✓ 勾 ✓ 框勾 ✗ 框叉 ? 问 ? 问 ● 圆 £ 镑 → 箭头",
  );
  assert.deepEqual(r.unrecommended, []);
  assert.equal(
    r.emojiRemaps.map((m) => m.from).join(""),
    "⏫⏬🗸🗹🗷❓❔",
    "emoji 呈现（媒体/追加符号/装饰问号）要求更换；⬤➠➢➣￠￡ 文本类不记",
  );
});

test("实机反馈回归（2026-11）：￦ 全角韩元归一、👉💡 图形族警告——反馈中「￦」不应再出现", () => {
  const rules = resolveSymbolRules();
  // 触发「[符号规范]」反馈的典型输入（含 ✅ 等 emoji、￦ 全角金额、👉💡 图形族）
  const r = normalizeSymbols(
    "完成 ✅ 韩元 ￦500 注意 👉 这里 灯泡 💡 想法",
    rules,
  );
  assert.equal(r.replacedCount, 2, "✅→✓、￦→₩ 各 1 处");
  assert.equal(r.text, "完成 ✓ 韩元 ₩500 注意 👉 这里 灯泡 💡 想法");
  // 警告只应含 👉💡（图形族）；￦ 已归一、绝不进警告
  assert.deepEqual(r.unrecommended, ["👉", "💡"], "￦ 绝不进 unrecommended");
  assert.equal(
    r.emojiRemaps.map((m) => m.from).join(""),
    "✅",
    "仅 ✅ 属 emoji 呈现（￦ 全角、👉💡 图形族非替换）",
  );
});
