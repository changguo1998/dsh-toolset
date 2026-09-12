// src/tool.ts — goal_contract_draft 工具工厂（宿主无关胶水层，可单测）
//
// 流程：解析预填（objective / clauses / clauses_text / max_goal_rounds）
//   → 访谈（仅补缺失字段，经 userQuestions 面，对齐 tool-ask-user）
//   → 校验并 buildObjective 嵌入 Done-when 段
//   → goals.create 落 dsh-goal 事件源（官方 goal/change 会话事件）
//   → goals.get 回读当前 goal 视图 → parseContract 解析条款 → 往返比对。
//
// deps 注入（userQuestions / goals）使 execute 可在单测中以 fake 服务运行；
// 服务缺失时按「预填可用 / 访谈不可用」降级并给出明确反馈。

import { parseClauseText, validateClauses } from "./clauses.ts";
import { buildObjective, clausesEqual, parseContract } from "./contract.ts";
import { applyAnswer, initialState, nextQuestion } from "./interview.ts";
import type {
  ContractClause,
  GoalsLike,
  HostAnswer,
  ToolExecLike,
  UserQuestionsLike,
} from "./types.ts";

/** 工具名（注册进宿主工具注册表）。 */
export const TOOL_NAME = "goal_contract_draft";

/** 工具描述（面向模型的调用指引）。 */
export const TOOL_DESCRIPTION = [
  "起草 goal 契约并落 dsh goal 事件源（goal/change）。",
  "字段：objective（目标描述）、clauses（Done-when 验证条款，schema 对齐 task-engine Acceptance：",
  "{id, check, level: mechanical|semantic|human, command?}，mechanical 必须带 command）。",
  "objective 与 clauses 齐备时直接创建；缺任一则经 ask_user 逐题访谈（目标→条款→确认）。",
  "创建后回读当前 goal 视图并解析 Done-when 条款，返回往返比对结果（readback.match）。",
].join(" ");

/** 工具依赖（apply 层注入；均可为 undefined，运行时降级）。 */
export interface GoalContractDeps {
  userQuestions?: UserQuestionsLike;
  goals?: GoalsLike;
  /** 观测日志（apply 层给 stderr 打印）。 */
  warn?: (message: string) => void;
}

/** 工具返回（Record 便于宿主 output schema 透传）。 */
export type ToolResult = Record<string, unknown>;

/** 失败返回。 */
function fail(message: string): ToolResult {
  return { ok: false, error: message };
}

/** 提取正整数（否则 undefined）。 */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** 构建 goal_contract_draft 工具定义（不触碰宿主运行时）。 */
export function createGoalContractTool(deps: GoalContractDeps) {
  const { userQuestions, goals, warn } = deps;
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      objective: {
        type: "string",
        required: false,
        description:
          "目标描述（预填；缺省时访谈向用户提问）。不得包含独占一行的 'Done-when:'。",
      },
      clauses: {
        type: "array",
        required: false,
        description:
          "Done-when 条款（结构化预填）：[{id, check, level, command?, output_schema?}]；level: mechanical/semantic/human，mechanical 必须带 command",
        items: { type: "object", additionalProperties: true, properties: {} },
      },
      clauses_text: {
        type: "string",
        required: false,
        description:
          "Done-when 条款（自由文本预填，每行一条：「描述」或「描述 → 命令」；与 clauses 二选一）",
      },
      max_goal_rounds: {
        type: "integer",
        required: false,
        description: "goal 回合上限（缺省宿主 256；自动化场景建议小值）",
      },
    },
    async execute(
      args: Record<string, unknown>,
      exec: ToolExecLike | undefined,
    ): Promise<ToolResult> {
      const agent = exec?.agent;
      const signal = exec?.signal;
      warn?.(`goal_contract_draft 调用：${JSON.stringify(args)}`);

      // ── 1) 解析预填：objective / clauses（结构化或文本）/ max_goal_rounds ──
      const objectiveArg =
        typeof args.objective === "string" ? args.objective.trim() : undefined;
      let preClauses: ContractClause[] | undefined;
      if (args.clauses !== undefined) {
        const v = validateClauses(args.clauses);
        if (!v.ok) return fail(`clauses 预填无效：${v.errors.join("；")}`);
        preClauses = v.clauses;
      } else if (typeof args.clauses_text === "string") {
        const v = parseClauseText(args.clauses_text);
        if (!v.ok) return fail(`clauses_text 预填无效：${v.errors.join("；")}`);
        preClauses = v.clauses;
      }
      const maxGoalRounds = positiveInteger(args.max_goal_rounds);
      if (args.max_goal_rounds !== undefined && maxGoalRounds === undefined) {
        return fail("max_goal_rounds 必须是正整数");
      }

      // ── 2) 访谈状态机：仅补缺失字段（预填跳过对应提问） ──
      let state = initialState({
        ...(objectiveArg === undefined ? {} : { objective: objectiveArg }),
        ...(preClauses === undefined ? {} : { clauses: preClauses }),
        ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
      });

      // objective 与 clauses 均预填 = 非交互路径：直接创建，不追问确认
      // （headless smoke 依赖此路径）；需访谈补齐时才进入提问循环（末尾确认）
      const prefillComplete =
        objectiveArg !== undefined &&
        preClauses !== undefined &&
        preClauses.length > 0;
      if (prefillComplete) {
        state = { ...state, phase: "done" };
      }
      for (;;) {
        const question = nextQuestion(state);
        if (question === null) break;
        if (
          userQuestions === undefined ||
          typeof userQuestions.ask !== "function"
        ) {
          return fail(
            "宿主 userQuestions 服务不可用（tool-ask-user 未挂载）；请改为预填 objective 与 clauses 后重试",
          );
        }
        // 单题 ask（对齐 tool-ask-user 的调用形状）
        let answer: HostAnswer;
        try {
          const result = await userQuestions.ask({
            questions: [
              {
                id: question.id,
                question: question.question,
                header: question.header,
                ...(question.options === undefined
                  ? {}
                  : { options: question.options }),
              },
            ],
            ...(agent === undefined ? {} : { agent }),
            ...(signal === undefined ? {} : { signal }),
          });
          const first = result.answers?.[0];
          answer =
            first === undefined
              ? { id: question.id, selected: [] }
              : {
                  id: first.id ?? question.id,
                  selected: first.selected ?? [],
                  ...(first.custom === undefined
                    ? {}
                    : { custom: first.custom }),
                };
        } catch (err) {
          // headless 无 UI answerer（NO_PROVIDER）等：给出可操作的降级建议
          return fail(
            `用户提问失败（${String(err)}）；请改为预填 objective 与 clauses 后重试`,
          );
        }
        state = applyAnswer(state, answer);
      }
      if (state.phase !== "done") {
        return fail(`访谈未通过：${state.abortReason ?? "未知原因"}`);
      }

      // ── 3) 校验并嵌入（状态机已校验，此处复核防御） ──
      const objective = state.objective;
      if (
        objective === undefined ||
        objective.length === 0 ||
        state.clauses.length === 0
      ) {
        return fail("契约不完整：objective 或 clauses 缺失");
      }
      let embedded: string;
      try {
        embedded = buildObjective(objective, state.clauses);
      } catch (err) {
        return fail(`契约嵌入失败：${String(err)}`);
      }

      // ── 4) 落 dsh-goal 事件源（goals.create → 官方 goal/change 会话事件） ──
      if (goals === undefined || typeof goals.create !== "function") {
        return fail("宿主 goals 服务不可用（dsh-goal 未挂载），无法落 goal");
      }
      let created;
      try {
        created = goals.create(agent, {
          objective: embedded,
          ...(state.maxGoalRounds === undefined
            ? {}
            : { maxGoalRounds: state.maxGoalRounds }),
        });
      } catch (err) {
        return fail(`落 goal 失败：${String(err)}`);
      }

      // ── 5) 回读：当前 goal 视图 → 解析 Done-when 条款 → 往返比对 ──
      const fresh =
        typeof goals.get === "function"
          ? (goals.get(agent) ?? created)
          : created;
      let readback: Record<string, unknown>;
      try {
        const parsed = parseContract(fresh.objective);
        readback = {
          objective: parsed.objective,
          clauses: parsed.clauses,
          match: clausesEqual(state.clauses, parsed.clauses),
        };
      } catch (err) {
        readback = {
          objective: fresh.objective,
          clauses: [],
          match: false,
          error: String(err),
        };
      }
      return {
        ok: true,
        goal: {
          id: fresh.id,
          revision: fresh.revision,
          phase: fresh.phase,
          maxGoalRounds: fresh.maxGoalRounds,
          roundsStarted: fresh.roundsStarted,
        },
        contract: { objective, clauses: state.clauses },
        objective_full: fresh.objective,
        readback,
      };
    },
    // dsh 0.1.5 ToolOutputDefinition 强制要求 output（schema + render）；
    // 结构面最小实现：把工具结果 JSON 序列化为文本块（宿主 materialize 负责截断）
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: JSON.stringify(value) },
      ],
    },
  };
}
