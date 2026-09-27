/**
 * demo：不依赖 DSH，演示「正文 → 回合审查 → notice + 模型反馈」与展示层归一。
 * 运行：npm run demo（先 build）。
 */

import { SymbolReviewer } from "../src/review.ts";
import { normalizeSymbols, resolveSymbolRules } from "../src/symbols.ts";

const rules = resolveSymbolRules();
const reviewer = new SymbolReviewer({ rules });

const cases: Array<{ sessionId: string; text: string }> = [
  { sessionId: "s1", text: "完成 ✔，失败 ❌，星标 ⭐。" },
  { sessionId: "s1", text: "同一会话重复：完成 ✔，失败 ❌，星标 ⭐。" },
  { sessionId: "s2", text: "另一个会话不受冷却影响：失败 ❌。" },
];

for (const item of cases) {
  console.log(`\n[${item.sessionId}] 正文：${item.text}`);
  const result = reviewer.review(item.sessionId, item.text);
  if (result === null) {
    console.log("  → 全冷却 / 无违规：跳过（不注入、不提示）");
    continue;
  }
  console.log(`  → notice：${result.notice}`);
  console.log(`  → 模型反馈：${result.feedback ?? "（warnModel 关闭）"}`);
}

console.log("\n展示层归一（normalize）：");
const display = normalizeSymbols("完成 ✔，失败 ❌，星标 ⭐。", rules);
console.log(
  `  ${display.text}（替换 ${display.replacedCount} 处；未推荐：${display.unrecommended.join("") || "无"}）`,
);
