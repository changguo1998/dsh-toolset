// tests/tool.test.ts — goal_contract_draft 工具胶水层（fake userQuestions / goals）
//
// fake goals 模拟 dsh-goal：create 记录 goal/change 事件（op=create），
// get 回读当前 goal 视图；fake userQuestions 按脚本逐题应答。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createGoalContractTool,
  TOOL_DESCRIPTION,
  TOOL_NAME,
} from "../src/tool.ts";
import type {
  GoalsLike,
  GoalViewLike,
  HostAnswer,
  HostQuestion,
  UserQuestionsLike,
} from "../src/types.ts";

const AGENT = { id: "test-agent" };
const EXEC = { agent: AGENT, signal: { aborted: false } };

const CLAUSES = [
  {
    id: "c1",
    check: "测试全绿",
    level: "mechanical" as const,
    command: "npm test",
  },
  { id: "c2", check: "用户验收", level: "human" as const },
];

/** fake dsh-goal：记录 goal/change 事件并支持回读（可篡改模拟外部编辑）。 */
function fakeGoals(
  opts: { createError?: Error; tamperReadback?: string } = {},
) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let current: GoalViewLike | undefined;
  let revision = 0;
  const service: GoalsLike = {
    create(agent, request) {
      if (opts.createError !== undefined) throw opts.createError;
      if (agent !== AGENT) throw new Error("agent 透传不一致");
      revision += 1;
      current = {
        id: `goal-test-${revision}`,
        revision: 1,
        objective: request.objective,
        phase: "active",
        maxGoalRounds: request.maxGoalRounds ?? 256,
        roundsStarted: 0,
      };
      // 模拟 dsh-goal：create 落官方 goal/change 会话事件
      events.push({
        type: "goal/change",
        data: { op: "create", goal: current },
      });
      return current;
    },
    get(agent) {
      if (agent !== AGENT) throw new Error("agent 透传不一致");
      // 可篡改回读视图（模拟 goal 被外部编辑后条款不一致）
      if (current !== undefined && opts.tamperReadback !== undefined) {
        return { ...current, objective: opts.tamperReadback };
      }
      return current;
    },
  };
  return { events, service };
}

/** fake userQuestions：按脚本顺序逐题应答；rejectError 模拟 NO_PROVIDER。 */
function fakeUserQuestions(
  scripts: HostAnswer[][],
  rejectError?: Error,
): { service: UserQuestionsLike; asked: HostQuestion[][] } {
  const asked: HostQuestion[][] = [];
  let call = 0;
  return {
    asked,
    service: {
      async ask(request) {
        asked.push(request.questions);
        if (rejectError !== undefined) throw rejectError;
        const scripted = scripts[Math.min(call, scripts.length - 1)];
        call += 1;
        return { answers: [...(scripted ?? [])] };
      },
    },
  };
}

test("全量预填：不提问，落 goal（goal/change 事件），回读往返一致", async () => {
  const goals = fakeGoals();
  const uq = fakeUserQuestions([]);
  const tool = createGoalContractTool({
    userQuestions: uq.service,
    goals: goals.service,
  });
  assert.equal(tool.name, TOOL_NAME);
  const result = await tool.execute(
    { objective: "实现 goal 契约插件", clauses: CLAUSES, max_goal_rounds: 2 },
    EXEC,
  );
  assert.equal(result.ok, true);
  // 全程无访谈
  assert.equal(uq.asked.length, 0);
  // 落了 goal/change 事件，objective 含 Done-when 段
  assert.equal(goals.events.length, 1);
  assert.equal(goals.events[0]?.type, "goal/change");
  const goal = result.goal as {
    id: string;
    revision: number;
    maxGoalRounds: number;
  };
  assert.equal(goal.id, "goal-test-1");
  assert.equal(goal.revision, 1);
  assert.equal(goal.maxGoalRounds, 2);
  // 回读往返一致
  const readback = result.readback as {
    objective: string;
    clauses: unknown[];
    match: boolean;
  };
  assert.equal(readback.match, true);
  assert.equal(readback.objective, "实现 goal 契约插件");
  assert.deepEqual(readback.clauses, CLAUSES);
  assert.ok(
    (result.objective_full as string).includes("Done-when:"),
    "objective_full 应含 Done-when 段",
  );
});

test("clauses_text 预填：自由文本解析后同样落 goal", async () => {
  const goals = fakeGoals();
  const tool = createGoalContractTool({
    userQuestions: fakeUserQuestions([]).service,
    goals: goals.service,
  });
  const result = await tool.execute(
    { objective: "o", clauses_text: "测试全绿 → npm test\n用户验收" },
    EXEC,
  );
  assert.equal(result.ok, true);
  const contract = result.contract as { clauses: unknown[] };
  assert.deepEqual(contract.clauses, [
    { id: "c1", check: "测试全绿", level: "mechanical", command: "npm test" },
    { id: "c2", check: "用户验收", level: "human" },
  ]);
});

test("只预填 objective：访谈 2 题（条款 + 确认）后落 goal", async () => {
  const goals = fakeGoals();
  const uq = fakeUserQuestions([
    [{ id: "clauses", selected: [], custom: "测试全绿 → npm test" }],
    [{ id: "confirm", selected: ["确认创建"] }],
  ]);
  const tool = createGoalContractTool({
    userQuestions: uq.service,
    goals: goals.service,
  });
  const result = await tool.execute({ objective: "实现插件" }, EXEC);
  assert.equal(result.ok, true);
  assert.deepEqual(
    uq.asked.map((q) => q[0]?.id),
    ["clauses", "confirm"],
  );
  assert.equal(goals.events.length, 1);
});

test("无预填：访谈 3 题（目标 + 条款 + 确认）", async () => {
  const goals = fakeGoals();
  const uq = fakeUserQuestions([
    [{ id: "objective", selected: [], custom: "实现 goal 契约插件" }],
    [{ id: "clauses", selected: [], custom: "文档齐全" }],
    [{ id: "confirm", selected: ["确认创建"] }],
  ]);
  const tool = createGoalContractTool({
    userQuestions: uq.service,
    goals: goals.service,
  });
  const result = await tool.execute({}, EXEC);
  assert.equal(result.ok, true);
  assert.deepEqual(
    uq.asked.map((q) => q[0]?.id),
    ["objective", "clauses", "confirm"],
  );
});

test("访谈中途取消：不落 goal，ok=false 且原因明确", async () => {
  const goals = fakeGoals();
  const uq = fakeUserQuestions([
    [{ id: "clauses", selected: [], custom: "测试全绿 → npm test" }],
    [{ id: "confirm", selected: ["取消"] }],
  ]);
  const tool = createGoalContractTool({
    userQuestions: uq.service,
    goals: goals.service,
  });
  const result = await tool.execute({ objective: "o" }, EXEC);
  assert.equal(result.ok, false);
  assert.ok((result.error as string).includes("访谈未通过"));
  assert.equal(goals.events.length, 0, "取消不得落 goal 事件");
});

test("headless 无 UI answerer（NO_PROVIDER）：明确建议改预填", async () => {
  const goals = fakeGoals();
  const uq = fakeUserQuestions([], new Error("NO_PROVIDER: 无用户提问应答方"));
  const tool = createGoalContractTool({
    userQuestions: uq.service,
    goals: goals.service,
  });
  const result = await tool.execute({}, EXEC);
  assert.equal(result.ok, false);
  assert.ok((result.error as string).includes("预填"));
  assert.equal(goals.events.length, 0);
});

test("goals 服务缺失 + 缺预填：降级提示 userQuestions 不可用前置于 goals 检查", async () => {
  const tool = createGoalContractTool({});
  const result = await tool.execute({}, EXEC);
  assert.equal(result.ok, false);
  assert.ok((result.error as string).includes("userQuestions"));
});

test("goals.create 失败（如 GOAL_ALREADY_EXISTS）：ok=false 且透传原因", async () => {
  const goals = fakeGoals({ createError: new Error("GOAL_ALREADY_EXISTS") });
  const tool = createGoalContractTool({
    userQuestions: fakeUserQuestions([]).service,
    goals: goals.service,
  });
  const result = await tool.execute({ objective: "o", clauses: CLAUSES }, EXEC);
  assert.equal(result.ok, false);
  assert.ok((result.error as string).includes("GOAL_ALREADY_EXISTS"));
});

test("回读被外部篡改：ok=true 但 readback.match=false 并暴露条款", async () => {
  const goals = fakeGoals({
    tamperReadback: "外部改写的 objective（无契约段）",
  });
  const tool = createGoalContractTool({
    userQuestions: fakeUserQuestions([]).service,
    goals: goals.service,
  });
  const result = await tool.execute({ objective: "o", clauses: CLAUSES }, EXEC);
  assert.equal(result.ok, true);
  const readback = result.readback as { match: boolean; clauses: unknown[] };
  assert.equal(readback.match, false);
  assert.deepEqual(readback.clauses, []);
});

test("参数校验：max_goal_rounds 非正整数 / clauses 预填非法 → ok=false", async () => {
  const goals = fakeGoals();
  const tool = createGoalContractTool({
    userQuestions: fakeUserQuestions([]).service,
    goals: goals.service,
  });
  const badRounds = await tool.execute(
    { objective: "o", clauses: CLAUSES, max_goal_rounds: 0 },
    EXEC,
  );
  assert.equal(badRounds.ok, false);
  const badClauses = await tool.execute(
    {
      objective: "o",
      clauses: [{ id: "c1", check: "c", level: "mechanical" }],
    },
    EXEC,
  );
  assert.equal(badClauses.ok, false);
  assert.ok((badClauses.error as string).includes("command"));
});

test("parameters 编译为标准 JSON Schema（网关 type:null 回归）", () => {
  const tool = createGoalContractTool({});
  const params = tool.parameters as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  // 顶层必须有 type:"object"（此前裸 property-map 被网关拒为 type:null）
  assert.equal(params.type, "object");
  assert.ok(params.properties !== undefined);
  // 四个字段都在 properties 中
  for (const field of [
    "objective",
    "clauses",
    "clauses_text",
    "max_goal_rounds",
  ]) {
    assert.ok(
      field in (params.properties as Record<string, unknown>),
      `缺 ${field}`,
    );
  }
  // 内联 required 标志被移除（不再残留于 property 上）
  for (const prop of Object.values(
    params.properties as Record<string, unknown>,
  )) {
    assert.ok(
      !("required" in (prop as Record<string, unknown>)),
      "property 上不应残留 required",
    );
  }
  // 全可选字段 → 不生成顶层 required 数组
  assert.equal(params.required, undefined);
  // 「objective 首行 = 一句话概括」约定（2026-10-07 用户裁定）：工具描述与 objective 参数描述都要写明
  // （状态列只显示首个非空行；全文经宿主 /goal 读）——TUI 侧渲染口径见 TUI/docs/SPEC.md §15.1。
  assert.ok(
    TOOL_DESCRIPTION.includes("首行必须是一句话概括"),
    "工具描述须写明首行概括约定",
  );
  const objectiveDesc =
    (params.properties as Record<string, { description?: string }>).objective
      ?.description ?? "";
  assert.ok(
    objectiveDesc.includes("首行必须是一句话概括"),
    "objective 参数描述须写明首行概括约定: " + objectiveDesc,
  );
  assert.ok(objectiveDesc.includes("/goal"), "须写明全文入口 = /goal");
});

test("output.render：全函数（undefined 也给 string；对象走 JSON、字符串原样）", () => {
  const tool = createGoalContractTool({});
  const render = tool.output.render as (
    args: unknown,
    value: unknown,
  ) => Array<{ type: string; text: unknown }>;
  // 裸 JSON.stringify(value) 在 value === undefined 时返回非字符串（宿主拒畸形块）
  const blocks = render({}, undefined);
  assert.equal(
    typeof blocks[0]?.text,
    "string",
    "render({}, undefined) 的 text 应为 string",
  );
  assert.equal(
    render({}, { a: 1 })[0]?.text,
    '{\n  "a": 1\n}',
    "对象走 JSON 分支",
  );
  assert.equal(render({}, "s")[0]?.text, "s", "字符串原样返回");
});

test("output.render 形参顺序哨兵：渲染的必须是第二参（变异回单形参必失败）", () => {
  const tool = createGoalContractTool({});
  assert.equal(tool.name, TOOL_NAME, "单工具注册（探针须覆盖全部）");
  const render = tool.output.render as (
    args: unknown,
    value: unknown,
  ) => Array<{ type?: string; text?: unknown }>;
  // 本包 render 是 jsonText(value)：整个 value 进 JSON 文本，任意字段都会回显 →
  // 最小结构即可。哨兵放 **value 位**；args 用同形结构、标记放同一可回显字段，
  // 形参写反 / 少参（单形参实现）时渲染器拿到的是 args → ②③ 双失败。
  const argsShaped = { marker: "ARGS_MARKER_NOT_RENDERED" };
  const valueShaped = { marker: "SENTINEL_VALUE_MARKER" };
  const text = render(argsShaped, valueShaped)[0]?.text;
  assert.equal(typeof text, "string", "blocks[0].text 必须是 string");
  assert.ok(
    String(text).includes("SENTINEL_VALUE_MARKER"),
    "渲染的必须是第二参（value）",
  );
  assert.ok(
    !String(text).includes("ARGS_MARKER_NOT_RENDERED"),
    "第一参（args）不该被当成 value 渲染",
  );
});

test("预填 objective 首行超限 → ok:false 且给可操作报错（不落 goal）", async () => {
  const goals = fakeGoals();
  const tool = createGoalContractTool({
    userQuestions: fakeUserQuestions([]).service,
    goals: goals.service,
  });
  const result = await tool.execute(
    { objective: "一".repeat(21), clauses: CLAUSES },
    EXEC,
  );
  assert.equal(result.ok, false);
  assert.ok(
    String(result.error).includes("首行"),
    "错误写明首行概括: " + String(result.error),
  );
  assert.equal(goals.events.length, 0, "未落 goal");
});
