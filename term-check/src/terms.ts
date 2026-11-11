/**
 * 术语表 section 的渲染（静态保持）：把随包发布的术语表快照渲染成**稳定文本**。
 *
 * 两段固定顺序：推荐术语（应当使用）在前, 禁止术语（旧称 → 应当使用）在后。
 * 行序与 `GLOSSARY_SNAPSHOT` 一致, 同快照必须同字节 —— 内容随快照只重启生效。
 */

import { GLOSSARY_SNAPSHOT, type GlossaryRow } from "./glossary.generated.ts";

/** section 名（全局唯一; 重复注册会被宿主拒绝）。 */
export const GLOSSARY_SECTION_NAME = "term-check/glossary";

/** section 排位（静态保持段统一 4xxx 段）。 */
export const GLOSSARY_SECTION_ORDER = 4200;

/** 「应当使用」列里指向推荐术语总表的占位文案（不当作具体术语）。 */
const POINTER = "见「推荐术语」";

/** 按出现顺序去重。 */
function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "" || value === "-" || value === POINTER) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 推荐术语（从各行「应当使用」列汇总, 去掉组合占位）。 */
export function recommendedTerms(rows: readonly GlossaryRow[]): string[] {
  return unique(rows.map((row) => row.to));
}

/** 渲染静态术语表正文；零行也返回标题, 保证段存在且稳定。 */
export function renderGlossarySection(
  rows: readonly GlossaryRow[] = GLOSSARY_SNAPSHOT,
): string {
  const recommended = recommendedTerms(rows);
  const lines = [
    "[术语表] 本仓口径（静态术语表；回复与文档按此写）",
    `推荐术语: ${recommended.join(" / ")}`,
    "禁止术语（旧称 → 应当使用）:",
  ];
  for (const row of rows) {
    lines.push(`- ${row.from.join(" / ")} → ${row.to}`);
  }
  return lines.join("\n");
}
