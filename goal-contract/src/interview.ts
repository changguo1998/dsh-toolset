// src/interview.ts — 访谈式起草状态机（纯函数，无宿主依赖，可单测）
//
// 流程：objective → clauses → confirm。预填字段跳过对应提问；
// 每阶段最多重问 maxAttempts 次，超限中止（防无限循环）。
// confirm 阶段为单选：[确认创建, 取消]。
//
// 状态机只产出问题与状态迁移；真正发起 ask 由 tool 层驱动
// （经宿主 userQuestions 面，对齐 tool-ask-user 的提问形状）。

import { parseClauseText } from "./clauses.ts";
import type { ClauseValidation, ContractClause } from "./types.ts";

export type InterviewPhase =
  "ask-objective" | "ask-clauses" | "ask-confirm" | "done" | "aborted";

/** 待提问项（宿主无关形状；tool 层透传给 userQuestions.ask）。 */
export interface InterviewQuestion {
  id: "objective" | "clauses" | "confirm";
  header: string;
  question: string;
  /** 选项（仅 confirm 阶段）。 */
  options?: { label: string; description?: string }[];
}

/** 一条回答（tool 层从宿主 HostAnswer 映射）。 */
export interface InterviewAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface InterviewState {
  phase: InterviewPhase;
  objective?: string;
  clauses: ContractClause[];
  /** 可选 goal 回合上限（工具参数透传，访谈不追问）。 */
  maxGoalRounds?: number;
  /** 当前阶段重问次数。 */
  attempts: number;
  /** 上一轮答案的校验错误（随下次提问反馈给用户）。 */
  error?: string;
  /** 中止原因（phase=aborted 时）。 */
  abortReason?: string;
  /** 累计提问数（观测用）。 */
  questionsAsked: number;
}

/** 确认选项 label（回答按 label 匹配）。 */
export const CONFIRM_LABEL = "确认创建";
export const CANCEL_LABEL = "取消";

/** 初始状态：objective/clauses 预填者跳过对应提问。 */
export function initialState(
  pre: {
    objective?: string;
    clauses?: ContractClause[];
    maxGoalRounds?: number;
  } = {},
): InterviewState {
  const phase: InterviewPhase =
    pre.objective === undefined
      ? "ask-objective"
      : pre.clauses === undefined || pre.clauses.length === 0
        ? "ask-clauses"
        : "ask-confirm";
  return {
    phase,
    ...(pre.objective === undefined ? {} : { objective: pre.objective }),
    clauses: pre.clauses ?? [],
    ...(pre.maxGoalRounds === undefined
      ? {}
      : { maxGoalRounds: pre.maxGoalRounds }),
    attempts: 0,
    questionsAsked: 0,
  };
}

/** 把上一轮校验错误拼进问题文本（重问时）。 */
function withError(question: string, error: string | undefined): string {
  return error === undefined
    ? question
    : `（上次回答未通过：${error}）\n${question}`;
}

/** 渲染契约预览（confirm 问题正文）。 */
export function renderContract(state: InterviewState): string {
  const lines = [state.objective ?? "", "", "Done-when:"];
  state.clauses.forEach((clause, i) => {
    lines.push(
      `${i + 1}. [${clause.id}] (${clause.level}) ${clause.check}` +
        (clause.command !== undefined ? ` → ${clause.command}` : ""),
    );
  });
  return lines.join("\n");
}

/** 下一个待提问项（null = 访谈已结束：done/aborted）。 */
export function nextQuestion(state: InterviewState): InterviewQuestion | null {
  switch (state.phase) {
    case "ask-objective":
      return {
        id: "objective",
        header: "目标",
        question: withError(
          "请用一句话描述这个 goal 契约的目标（objective）：要解决什么问题 / 交付什么。",
          state.error,
        ),
      };
    case "ask-clauses":
      return {
        id: "clauses",
        header: "验证条款",
        question: withError(
          [
            "请列出 Done-when 验证条款（每行一条）：",
            "- 「检查描述」= 人工确认级（human）",
            "- 「检查描述 → 验证命令」= 命令验证级（mechanical）",
            "- 可加前缀 [mechanical]/[semantic]/[human] 显式指定层级",
            '- 也可直接给 JSON 数组：[{"id":"c1","check":"...","level":"mechanical","command":"..."}]',
          ].join("\n"),
          state.error,
        ),
      };
    case "ask-confirm":
      return {
        id: "confirm",
        header: "确认",
        question:
          "确认后将以该 goal 契约创建 dsh goal（条款嵌入 goal objective 的 Done-when 段）：\n\n" +
          renderContract(state),
        options: [
          {
            label: CONFIRM_LABEL,
            description: "创建 goal（落 goal/change 事件源）",
          },
          { label: CANCEL_LABEL, description: "放弃本次起草" },
        ],
      };
    default:
      return null;
  }
}

/**
 * 应用一条回答并推进状态（纯迁移，不抛错）。
 * 空回答 / 校验失败 → 同阶段重问（attempts+1）；达到 maxAttempts 中止。
 */
export function applyAnswer(
  state: InterviewState,
  answer: InterviewAnswer,
  maxAttempts: number = 3,
): InterviewState {
  // 终态不可迁移
  if (state.phase === "done" || state.phase === "aborted") return state;
  const attempts = state.attempts + 1;
  const base: InterviewState = {
    ...state,
    attempts,
    error: undefined,
    questionsAsked: state.questionsAsked + 1,
  };
  const exhaust = (): InterviewState => ({
    ...base,
    phase: "aborted",
    abortReason: `${state.phase} 阶段超过 ${maxAttempts} 次重问`,
  });
  switch (state.phase) {
    case "ask-objective": {
      // 自由输入：优先 custom，回落 selected 拼接
      const text =
        answer.id === "objective"
          ? (answer.custom ?? answer.selected.join(" ")).trim()
          : "";
      if (text.length === 0) {
        return attempts >= maxAttempts
          ? exhaust()
          : { ...base, error: "objective 不能为空，请输入目标描述" };
      }
      return {
        ...base,
        objective: text,
        phase: "ask-clauses",
        attempts: 0,
      };
    }
    case "ask-clauses": {
      const raw =
        answer.id === "clauses"
          ? (answer.custom ?? answer.selected.join("\n")).trim()
          : "";
      if (raw.length === 0) {
        return attempts >= maxAttempts
          ? exhaust()
          : {
              ...base,
              error: "条款文本不能为空，请至少给一条 Done-when 条款",
            };
      }
      const v: ClauseValidation = parseClauseText(raw);
      if (!v.ok) {
        return attempts >= maxAttempts
          ? exhaust()
          : { ...base, error: v.errors.join("；") };
      }
      return {
        ...base,
        clauses: v.clauses,
        phase: "ask-confirm",
        attempts: 0,
      };
    }
    case "ask-confirm": {
      // 按确认 label 匹配（含 confirm/yes/确认 同义）；其余一律视为取消
      const text = [
        answer.id === "confirm" ? (answer.custom ?? "") : "",
        ...answer.selected,
      ].join(" ");
      const confirmed =
        text.includes(CONFIRM_LABEL) || /confirm|yes|确认/i.test(text);
      return confirmed
        ? { ...base, phase: "done", attempts: 0 }
        : { ...base, phase: "aborted", abortReason: "用户取消了起草" };
    }
    default:
      return state;
  }
}
