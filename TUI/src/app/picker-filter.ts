// src/app/picker-filter.ts — /model 面板筛选（纯函数：匹配分档 / 可见列表 / 键判定）
//
// 只筛**当前焦点列**：provider 列与 model 列各记各的筛选词（`PickerState.providerFilter`
// / `modelFilter`），effort 列不筛（3 项上下即达，无筛选价值）。可见列表 = 原列表里
// 命中的项按匹配程度排序；筛选词为空 → 原序返回（默认序，当前生效值恒首位）。
//
// **可见序是唯一真源**：渲染（components/ModelPicker.ts）、reducer（state.ts 的
// picker-move / picker-select）、resolvePickerSelection（model-transition.ts）与
// reloadPickerEfforts（index.ts）全部经本模块取列表或焦点值 —— 各自按下标读原列表
// 会「显示一套、取值另一套」（空格选中 / Enter 提交落到别的行）。
//
// 类型依赖单向：本模块只 `import type` PickerState，state.ts 反向值引入本模块，无环。

import type { PickerState } from "./state.ts";

/** 可筛的列（effort 列不筛） */
export type PickerFilterColumn = "provider" | "model";

/** 焦点区 → 可筛列；effort 列（2）→ null */
export function pickerFilterColumn(phase: number): PickerFilterColumn | null {
  if (phase === 0) return "provider";
  if (phase === 1) return "model";
  return null;
}

/** 当前焦点列的筛选词（effort 列无筛选 → 恒空串） */
export function pickerFilterText(picker: PickerState): string {
  const col = pickerFilterColumn(picker.phase);
  if (col === "provider") return picker.providerFilter ?? "";
  if (col === "model") return picker.modelFilter ?? "";
  return "";
}

/** 段首边界字符：筛选词紧跟其后出现即算「段首」（如 `qwen-max` 的 `max`、`a/b` 的 `b`） */
const BOUNDARY = new Set(["-", "_", "/", ".", ":", " "]);

/**
 * 匹配分档（`rank` 越小越靠前）+ 匹配起点（`at`）：
 * 0 全等 / 1 前缀 / 2 段首前缀 / 3 子串 / 4 子序列（按序命中、可跳过字符）；
 * 不匹配 → null。大小写不敏感（模型名大小写混排，如 `gpt-5-Codex`）。
 */
function matchClass(
  item: string,
  query: string,
): { rank: number; at: number } | null {
  const s = item.toLowerCase();
  const q = query.toLowerCase();
  if (s === q) return { rank: 0, at: 0 };
  if (s.startsWith(q)) return { rank: 1, at: 0 };
  const at = s.indexOf(q);
  if (at > 0) return { rank: BOUNDARY.has(s[at - 1]!) ? 2 : 3, at };
  // 子序列：逐个贪心吃 query 的字符，吃不完即不匹配
  let i = 0;
  let first = -1;
  for (let k = 0; k < s.length && i < q.length; k++) {
    if (s[k] !== q[i]) continue;
    if (first < 0) first = k;
    i += 1;
  }
  if (i < q.length) return null;
  return { rank: 4, at: first < 0 ? 0 : first };
}

/**
 * 可见列表：命中项按匹配程度排序 —— 分档 → 匹配起点 → 名称更短 → 原索引（稳定）；
 * 筛选词为空 → 原序返回（默认序是同一实现的退化情形, 不是另一条分支）。
 */
export function rankPickerItems(
  items: readonly string[],
  query: string,
): string[] {
  if (query === "") return [...items];
  const hit: { item: string; rank: number; at: number; idx: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const m = matchClass(item, query);
    if (m) hit.push({ item, rank: m.rank, at: m.at, idx: i });
  }
  hit.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.at - b.at ||
      a.item.length - b.item.length ||
      a.idx - b.idx,
  );
  return hit.map((h) => h.item);
}

/** provider 列可见列表（按 providerFilter 筛选排序） */
export function pickerVisibleProviders(picker: PickerState): string[] {
  return rankPickerItems(picker.providers, picker.providerFilter ?? "");
}

/** model 列可见列表（按 modelFilter 筛选排序；源为星号 provider 的模型列表） */
export function pickerVisibleModels(picker: PickerState): string[] {
  return rankPickerItems(picker.models, picker.modelFilter ?? "");
}

/**
 * 各列焦点行（`>` 指示）的值，按可见序取下标；effort 列不在内 ——
 * 其选中键是 `id` 而非显示名 `name`。星号（`selectedX`）优先于本函数，
 * 由调用方按「星号 ?? 焦点行」的既有口径处理。
 */
export function pickerFocusedValues(picker: PickerState): {
  provider?: string;
  model?: string;
} {
  return {
    provider: pickerVisibleProviders(picker)[picker.providerIndex],
    model: pickerVisibleModels(picker)[picker.modelIndex],
  };
}

/**
 * 筛选词逐键编辑：可打印单字符（无 Ctrl）→ 追加到末尾；`backspace` → 删末字符
 * （按 code point 拆, CJK 算 1 个字符）；其余键 → null（交回键路由）。
 * 无光标移动：←/→ 已用于切列, 故筛选词只支持「追加 + 删尾」。
 */
export function pickerFilterInput(
  current: string,
  name: string,
  ctrl: boolean,
): string | null {
  if (ctrl) return null;
  if (name === "backspace") {
    const chars = Array.from(current);
    return chars.length === 0 ? null : chars.slice(0, -1).join("");
  }
  if (name.length === 1 && name >= " " && name !== "\x7f")
    return current + name;
  return null;
}
