// src/app/question-transition.ts — 问答面板纯状态转换（无副作用）
//
// 自 App（index.ts）拆出：按键路由决策（questionKeyDecision）与整批答案聚合
// （buildQuestionAnswers）。cancel/submit 的适配器调用（adapter.cancelQuestion /
// answerQuestion）与 paint 仍由 App 执行，副作用顺序与原实现一致。

import type { QuestionPanelItem, QuestionPanelState } from "./state.ts";
import type { QuestionAnswer } from "./adapter/dsh.ts";

/** 问答按键决策：纯数据，由 App 分派状态动作 / 执行副作用 */
export type QuestionKeyDecision =
  | { kind: "cancel" } // Esc：App → cancelQuestion（reject ask + 关闭面板）
  | { kind: "submit" } // 最后一题 + Enter：App → submitQuestion（answerQuestion + 关闭面板）
  | { kind: "nav"; delta: 1 | -1 } // left/right / Enter(还有下一题)：question-nav
  | { kind: "move"; delta: 1 | -1 } // up/down（焦点在选项窗）：question-move
  | { kind: "focus" } // Tab：切焦点窗（描述窗 <-> 选项窗）→ question-focus
  | { kind: "desc-scroll"; delta: 1 | -1 } // up/down（焦点在描述窗）：question-desc-scroll
  /** 自定义项文本编辑（BACKLOG TUI#35 起携光标）：question-custom */
  | { kind: "custom-edit"; text: string; caret: number | null }
  /** 自定义项光标左右移动（TUI#35，仅编辑态）：custom-caret */
  | { kind: "custom-caret"; delta: 1 | -1 }
  | { kind: "select" } // 预设选项标记/取消标记（空格 / Ctrl+Space）：question-select
  | { kind: "digit"; n: number } // 数字键 1-9：直接标记第 n 项（不提交，BACKLOG 3.2.6）
  | { kind: "none" }; // 吞掉按键（无状态变化、无重绘）

/** 高亮是否在“自定义回答”兑底项（列表末位，optionIndex = options.length） */
function isOnCustom(panel: QuestionPanelState): boolean {
  const item = panel.items[panel.itemIndex];
  return !!item && item.optionIndex >= item.options.length;
}

/** 自定义答案文本按 code point 拆分（光标偏移与之一致，CJK 按 1 个字符计） */
function customChars(item: QuestionPanelItem | undefined): string[] {
  return Array.from(item?.custom ?? "");
}

/** 编辑态光标（BACKLOG TUI#35）：null ⟺ 未编辑；越界夹到串长 */
function customCaretOf(item: QuestionPanelItem | undefined): number | null {
  const c = item?.customCaret;
  if (c === undefined || c === null) return null;
  return Math.max(0, Math.min(c, customChars(item).length));
}

/** 在光标处插入（空串插入 = 进入编辑态） */
function customInsert(
  item: QuestionPanelItem | undefined,
  ch: string,
): Extract<QuestionKeyDecision, { kind: "custom-edit" }> {
  const chars = customChars(item);
  const at = customCaretOf(item) ?? chars.length;
  const text = [...chars.slice(0, at), ch, ...chars.slice(at)].join("");
  return { kind: "custom-edit", text, caret: at + Array.from(ch).length };
}

/**
 * 纯按键路由：按键 + 当前面板状态 → 决策。
 *
 * - Esc → cancel（仅取消问答，绝不 interrupt）
 * - Enter → 还有下一题：nav +1；最后一题：submit 整批答案
 * - 退格 → 自定义项：编辑态在光标处删除（删空回未编辑态）；非编辑态删末字符；其余位置吞掉
 * - 空格 → 自定义项：输入空格；预设选项：标记/取消标记
 * - 数字键 1-9 → 直接标记第 n 项（越界吞掉；自定义项上仍按文本输入，BACKLOG 3.2.6）
 * - 其他可打印字符（无 Ctrl）→ 仅自定义项在光标处插入；预设选项上吞掉
 * - up/down → 焦点在选项窗：move；焦点在描述窗：desc-scroll（BACKLOG 3.2.1）
 * - left/right → 自定义项**编辑态**：串内移动光标（TUI#35）；否则切题 nav
 * - Tab → focus（描述窗 <-> 选项窗切换，BACKLOG 3.2.1）
 * - 其余 → 吞掉（不落入主输入栏）
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
      const chars = customChars(item);
      const caret = customCaretOf(item);
      if (chars.length === 0) return { kind: "none" };
      if (caret === null) {
        const text = chars.slice(0, -1).join("");
        return {
          kind: "custom-edit",
          text,
          caret: text === "" ? null : chars.length - 1,
        };
      }
      if (caret === 0) return { kind: "none" };
      const text = [...chars.slice(0, caret - 1), ...chars.slice(caret)].join(
        "",
      );
      return {
        kind: "custom-edit",
        text,
        caret: text === "" ? null : caret - 1,
      };
    }
    return { kind: "none" };
  }
  if (name === " " || name === "space") {
    if (onCustom) return customInsert(item, " ");
    return { kind: "select" };
  }
  if (name.length === 1 && name >= "1" && name <= "9" && !ctrl) {
    // 数字键 = 直接标记第 n 项（BACKLOG 3.2.6）；自定义项编辑态仍按文本输入处理
    if (onCustom) return customInsert(item, name);
    return { kind: "digit", n: Number(name) };
  }
  if (name.length === 1 && !ctrl) {
    if (onCustom) return customInsert(item, name);
    return { kind: "none" };
  }
  if (name === "tab") return { kind: "focus" };
  if (name === "up" || name === "down") {
    const delta = name === "down" ? 1 : -1;
    // 焦点窗决定 ↑/↓ 语义（BACKLOG 3.2.1）：描述窗滚行、选项窗移项
    if (item?.focus === "desc") return { kind: "desc-scroll", delta };
    return { kind: "move", delta };
  }
  if (name === "left" || name === "right") {
    const delta: 1 | -1 = name === "right" ? 1 : -1;
    // 自定义项编辑态（TUI#35）：←/→ 在串内移动光标；未编辑态仍是切题导航
    if (onCustom && customCaretOf(item) !== null)
      return { kind: "custom-caret", delta };
    return { kind: "nav", delta };
  }
  return { kind: "none" };
}

/** 聚合整批答案为交给 adapter.answerQuestion 的 QuestionAnswer（提交前计算，不含副作用）。
 *  未标记任何选项（selected 为空）且无自定义输入时，默认提交当前选中的（高亮）选项；
 *  与 StatusPanel 的「无预选回退焦点行」语义一致。高亮在自定义兜底项时无选项可回退。 */
export function buildQuestionAnswers(
  panel: QuestionPanelState,
): QuestionAnswer {
  const answers = panel.items.map((it) => {
    let selected = it.selected;
    if (selected.length === 0 && !it.custom) {
      const label = it.options[it.optionIndex]?.label;
      if (label) selected = [label];
    }
    return {
      id: it.id,
      selected,
      ...(it.custom ? { custom: it.custom } : {}),
    };
  });
  return { answers };
}
