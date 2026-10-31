// tests/integration/plugin.test.ts — 插件装配层：apply 注册、服务取用与失败路径
//
// 对象是宿主接线（不是单个纯函数）：假工具面 / 假事件面 / 假服务面由
// tests/assemble.ts 拼出，断言工具注册的 canonical 值、`execute` 的返回、
// `output.render` 的投影文本，以及服务缺席与抛错时的降级反馈。
import assert from "node:assert/strict";
import { test } from "node:test";

import { inject, name } from "../../src/index.ts";
import { TOOL_DESCRIPTION, TOOL_NAME } from "../../src/tool.ts";
import {
  assemble,
  createGoalStore,
  createUserQuestions,
  type GoalStore,
  type UserQuestionsStore,
} from "../assemble.ts";

const AGENT = { id: "integration-agent" };
const SIGNAL = { aborted: false };
const EXEC = { agent: AGENT, signal: SIGNAL };

const OBJECTIVE = "实现 goal 契约插件";
const CLAUSES = [
  { id: "c1", check: "测试全绿", level: "mechanical", command: "npm test" },
  { id: "c2", check: "用户验收", level: "human" },
];
const EMBEDDED = `${OBJECTIVE}\n\nDone-when:\n${JSON.stringify(CLAUSES, null, 2)}`;

test("装配: bundle 契约符号与唯一工具注册的 canonical 值", () => {
  const goals = createGoalStore();
  const uq = createUserQuestions();
  const a = assemble({ userQuestions: uq.service, goals: goals.service });

  // bundle 导出契约（cordis.patch.yml 的插件 id 与 inject 声明）
  assert.equal(name, "goal-contract");
  assert.deepEqual(inject, ["tools", "userQuestions", "goals"]);

  // 只注册一个工具；名字与描述是模型可见面的 canonical 值
  assert.deepEqual(a.tools.names(), [TOOL_NAME]);
  const tool = a.tool();
  assert.equal(tool.name, "goal_contract_draft");
  assert.equal(tool.description, TOOL_DESCRIPTION);
  assert.match(tool.description, /^用途: 起草 goal 契约/);

  // 参数编译成 JSON Schema（顶层 type:object，四个可选字段，无 required）
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(Object.keys(tool.parameters.properties ?? {}), [
    "objective",
    "clauses",
    "clauses_text",
    "max_goal_rounds",
  ]);
  assert.equal(tool.parameters.required, undefined);
  assert.deepEqual(tool.output.schema, {
    type: "object",
    additionalProperties: true,
    properties: {},
  });

  // 本包不订阅事件、不 provide 服务；正常装配无 stderr 告警
  assert.equal(a.events.listenerCount(), 0);
  assert.deepEqual(a.services.names(), ["userQuestions", "goals"]);
  assert.deepEqual(a.stderr, []);
});

test("执行: 全量预填落 goal/change, 返回 canonical 结果并回读往返一致", async () => {
  const goals = createGoalStore();
  const a = assemble({
    userQuestions: createUserQuestions().service,
    goals: goals.service,
  });

  const result = await a.execute(
    { objective: OBJECTIVE, clauses: CLAUSES, max_goal_rounds: 2 },
    EXEC,
  );

  assert.deepEqual(result, {
    ok: true,
    goal: {
      id: "goal-1",
      revision: 1,
      phase: "active",
      maxGoalRounds: 2,
      roundsStarted: 0,
    },
    contract: { objective: OBJECTIVE, clauses: CLAUSES },
    objective_full: EMBEDDED,
    readback: { objective: OBJECTIVE, clauses: CLAUSES, match: true },
  });

  // 落点是官方 goal/change 事件，objective 含 Done-when 段
  assert.equal(goals.events.length, 1);
  assert.equal(goals.events[0]?.type, "goal/change");
  assert.equal(goals.events[0]?.data["op"], "create");
  assert.deepEqual(goals.requests, [{ objective: EMBEDDED, maxGoalRounds: 2 }]);
});

test("投影: output.render 把结果序列化为单个 JSON 文本块", async () => {
  const goals = createGoalStore();
  const a = assemble({ goals: goals.service });
  const result = await a.execute(
    { objective: OBJECTIVE, clauses: CLAUSES },
    EXEC,
  );

  const text = a.render(result);
  assert.equal(typeof text, "string");
  assert.equal(text, JSON.stringify(result, null, 2));
  assert.deepEqual(JSON.parse(String(text)), result, "投影文本可还原为结果");
});

test("执行: 访谈路径经 ctx.get 取 userQuestions, 透传 agent 与 signal", async () => {
  const goals = createGoalStore();
  const uq = createUserQuestions([
    [{ id: "clauses", selected: [], custom: "测试全绿 → npm test" }],
    [{ id: "confirm", selected: ["确认创建"] }],
  ]);
  const a = assemble({ userQuestions: uq.service, goals: goals.service });

  const result = await a.execute({ objective: OBJECTIVE }, EXEC);

  assert.equal(result["ok"], true);
  assert.deepEqual(
    uq.asked.map((questions) => questions[0]?.id),
    ["clauses", "confirm"],
  );
  assert.equal(uq.contexts.length, 2);
  assert.deepEqual(uq.contexts[0], { agent: AGENT, signal: SIGNAL });

  // 访谈解析出的条款（c1 mechanical）与 objective 一起嵌入
  const interviewClauses = [
    { id: "c1", check: "测试全绿", level: "mechanical", command: "npm test" },
  ];
  assert.deepEqual(goals.requests, [
    {
      objective: `${OBJECTIVE}\n\nDone-when:\n${JSON.stringify(interviewClauses, null, 2)}`,
    },
  ]);
});

test("装配: tools 面缺席与 register 抛错的降级（不抛错，写 stderr）", () => {
  const absent = assemble({ tools: "missing" });
  assert.deepEqual(absent.tools.names(), []);
  assert.deepEqual(absent.stderr, [
    "[goal-contract] warn: ctx.tools 不可用，跳过工具注册\n",
  ]);

  const throwing = assemble({
    tools: "throwing",
    userQuestions: createUserQuestions().service,
    goals: createGoalStore().service,
  });
  assert.deepEqual(throwing.tools.names(), []);
  assert.deepEqual(throwing.stderr, [
    "[goal-contract] warn: goal_contract_draft 注册失败：Error: tools.register 拒绝注册\n",
  ]);
});

test("装配: 服务缺席时告警但工具仍注册, 执行给 canonical 错误", async () => {
  const a = assemble();
  assert.deepEqual(a.stderr, [
    "[goal-contract] warn: userQuestions 服务不可用（tool-ask-user 未挂载），访谈将不可用（预填路径不受影响）\n",
    "[goal-contract] warn: goals 服务不可用（dsh-goal 未挂载），无法落 goal\n",
  ]);
  assert.deepEqual(a.tools.names(), [TOOL_NAME]);

  // 预填齐备 → 走到落 goal 才发现 goals 缺席
  const prefill = await a.execute(
    { objective: OBJECTIVE, clauses: CLAUSES },
    EXEC,
  );
  assert.deepEqual(prefill, {
    ok: false,
    error: "宿主 goals 服务不可用（dsh-goal 未挂载），无法落 goal",
  });

  // 预填不足 → 先撞上 userQuestions 缺席
  const interview = await a.execute({}, EXEC);
  assert.deepEqual(interview, {
    ok: false,
    error:
      "宿主 userQuestions 服务不可用（tool-ask-user 未挂载）；请改为预填 objective 与 clauses 后重试",
  });
});

test("装配: 无 ctx.get 时回落到直连属性", async () => {
  const goals = createGoalStore();
  const uq = createUserQuestions();
  const a = assemble({
    services: "direct",
    userQuestions: uq.service,
    goals: goals.service,
  });
  assert.deepEqual(a.stderr, [], "直连属性可取到两个服务");
  const result = await a.execute(
    { objective: OBJECTIVE, clauses: CLAUSES },
    EXEC,
  );
  assert.equal(result["ok"], true);
});

test("失败路径: 访谈取消 / create 抛错 / 首行超限 / 回读解析异常", async () => {
  // 访谈取消（确认题选取消）
  const cancelledGoals: GoalStore = createGoalStore();
  const cancelled = assemble({
    userQuestions: createUserQuestions([
      [{ id: "clauses", selected: [], custom: "文档齐全" }],
      [{ id: "confirm", selected: ["取消"] }],
    ]).service,
    goals: cancelledGoals.service,
  });
  assert.deepEqual(await cancelled.execute({ objective: OBJECTIVE }, EXEC), {
    ok: false,
    error: "访谈未通过：用户取消了起草",
  });
  assert.equal(cancelledGoals.events.length, 0, "取消不得落 goal");

  // goals.create 抛错（如已有 goal）
  const rejectingGoals = createGoalStore({
    createError: new Error("GOAL_ALREADY_EXISTS"),
  });
  const rejecting = assemble({ goals: rejectingGoals.service });
  const rejected = await rejecting.execute(
    { objective: OBJECTIVE, clauses: CLAUSES },
    EXEC,
  );
  assert.equal(rejected["ok"], false);
  assert.match(String(rejected["error"]), /GOAL_ALREADY_EXISTS/);

  // 首行概括超限（41 显示列）
  const overGoal = createGoalStore();
  const over = assemble({ goals: overGoal.service });
  const overResult = await over.execute(
    { objective: "一".repeat(21), clauses: CLAUSES },
    EXEC,
  );
  assert.equal(overResult["ok"], false);
  assert.match(String(overResult["error"]), /首行（一句话概括）过长/);
  assert.equal(overGoal.events.length, 0);

  // 回读解析异常不翻转 ok，用 readback.error 说明
  const tamperedGoals = createGoalStore();
  tamperedGoals.tamper("被改写的目标\n\nDone-when:\n[{broken");
  const tampered = assemble({ goals: tamperedGoals.service });
  const tamperedResult = await tampered.execute(
    { objective: OBJECTIVE, clauses: CLAUSES },
    EXEC,
  );
  assert.equal(tamperedResult["ok"], true);
  const readback = tamperedResult["readback"] as {
    match: boolean;
    error?: string;
  };
  assert.equal(readback.match, false);
  assert.match(String(readback.error), /Done-when 段不是合法 JSON/);
});

test("执行: userQuestions 拒绝（NO_PROVIDER）与空答案重问上限", async () => {
  const rejectGoals: GoalStore = createGoalStore();
  const rejected = assemble({
    userQuestions: createUserQuestions([], {
      reject: new Error("NO_PROVIDER: 无用户提问应答方"),
    }).service,
    goals: rejectGoals.service,
  });
  const rejectedResult = await rejected.execute({}, EXEC);
  assert.equal(rejectedResult["ok"], false);
  assert.match(
    String(rejectedResult["error"]),
    /请改为预填 objective 与 clauses/,
  );
  assert.equal(rejectGoals.events.length, 0);

  // 每轮返回空 answers → 视为空回答，3 次后中止
  const emptyGoals: GoalStore = createGoalStore();
  const emptyUq: UserQuestionsStore = createUserQuestions([[]]);
  const empty = assemble({
    userQuestions: emptyUq.service,
    goals: emptyGoals.service,
  });
  const emptyResult = await empty.execute({}, EXEC);
  assert.equal(emptyResult["ok"], false);
  assert.match(String(emptyResult["error"]), /访谈未通过/);
  assert.equal(emptyUq.asked.length, 3);
  assert.equal(emptyGoals.events.length, 0);
});
