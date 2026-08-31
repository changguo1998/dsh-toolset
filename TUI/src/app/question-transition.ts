// src/app/question-transition.ts — 问答面板纯状态转换（无副作用）
//
// 自 App（index.ts）拆出：按键路由决策（questionKeyDecision）与整批答案聚合
// （buildQuestionAnswers）。cancel/submit 的适配器调用（adapter.cancelQuestion /
// answerQuestion）与 paint 仍由 App 执行，副作用顺序与原实现一致。

import type { QuestionPanelState } from "./state.ts";
import type { QuestionAnswer } from "./adapter/dsh.ts";

/** 问答按键决策：纯数据，由 App 分派状态动作 / 执行副作用 */
export type QuestionKeyDecision =
  | { kind: "cancel" } // Esc：App → cancelQuestion（reject ask + 关闭面板）
  | { kind: "submit" } // 最后一题 + Enter：App → submitQuestion（answerQuestion + 关闭面板）
  | { kind: "nav"; delta: 1 | -1 } // left/right / Enter(还有下一题)：question-nav
  | { kind: "move"; delta: 1 | -1 } // up/down：question-move
  | { kind: "custom"; text: string } // 自定义项文本编辑：question-custom
  | { kind: "select" } // 预设选项选中/取消（空格 / Ctrl+Space）：question-select
  | { kind: "none" }; // 吞掉按键（无状态变化、无重绘）

/** 高亮是否在“自定义回答”兑底项（列表末位，optionIndex = options.length） */
function isOnCustom(panel: QuestionPanelState): boolean {
  const item = panel.items[panel.itemIndex];
  return !!item && item.optionIndex >= item.options.length;
}

/**
 * 纯按键路由：按键 + 当前面板状态 → 决策。
 *
 * - Esc → cancel（仅取消问答，绝不 interrupt）
 * - Enter → 还有下一题：nav +1；最后一题：submit 整批答案
 * - 退格 → 仅自定义项高亮时删除末字符；其余位置吞掉
 * - 空格 → 自定义项：输入空格；预设选项：选中/取消
 * - 其他可打印字符（无 Ctrl）→ 仅自定义项追加；预设选项上吞掉
 * - up/down → move；left/right → nav
 * - 其余（Tab 等）→ 吞掉（不落入主输入栏，也不再切焦点）
 */
export function questionKeyDecision(
  panel: QuestionPanelState,
  name: string,
  ctrl: boolean,
): QuestionKeyDecision {
  const item = panel.items[panel.itemIndex];
  const onCustom = isOnCustom(panel);

  if (name === "escape") return { kind: "cancel" };
  if (name === "enter") {
    if (panel.itemIndex < panel.items.length - 1)
      return { kind: "nav", delta: 1 };
    return { kind: "submit" };
  }
  if (name === "backspace") {
    if (onCustom) {
      const t = item?.custom ?? "";
      return { kind: "custom", text: t.slice(0, Math.max(0, t.length - 1)) };
    }
    return { kind: "none" };
  }
  if (name === " " || name === "space") {
    if (onCustom) return { kind: "custom", text: (item?.custom ?? "") + " " };
    return { kind: "select" };
  }
  if (name.length === 1 && !ctrl) {
    if (onCustom) return { kind: "custom", text: (item?.custom ?? "") + name };
    return { kind: "none" };
  }
  if (name === "up" || name === "down") {
    return { kind: "move", delta: name === "down" ? 1 : -1 };
  }
  if (name === "left" || name === "right") {
    return { kind: "nav", delta: name === "right" ? 1 : -1 };
  }
  return { kind: "none" };
}

/** 聚合整批答案为交给 adapter.answerQuestion 的 QuestionAnswer（提交前计算，不含副作用） */
export function buildQuestionAnswers(
  panel: QuestionPanelState,
): QuestionAnswer {
  const answers = panel.items.map((it) => ({
    id: it.id,
    selected: it.selected,
    ...(it.custom ? { custom: it.custom } : {}),
  }));
  return { answers };
}
