// scripts/executor-smoke.mjs — 常驻冒烟：executor 主机适配层（src/main.ts）
//
// 为什么需要它：单测覆盖引擎侧（门禁 / execute 语义 / 工具解析），demo 只演示 subagent
// 且用自建 runner，都踩不到 apply() 的宿主接线。本脚本用「真实 dist + 假宿主面」跑该层：
//   工具族 / subagent 的 agentOptions 映射与用量口径 / 未声明模型不传 agentOptions /
//   command 真跑 /bin/sh / workflow 默认 meta 合并 + 对象证据 / 同步抛错不打回 /
//   cancelled 反馈 / 宿主服务惰性解析 / 证据截断 / execute → stop → join。
//
// 运行：npm run smoke:executor（前置 npm run build，产出 dist）
// 通过输出 SMOKE_PASS；任一断言失败输出 FAIL 行并以退出码 1 结束。

import { apply, MAX_EVIDENCE_CHARS, truncateEvidence } from "../dist/index.js";

let failed = 0;
const log = (s) => process.stdout.write(`[smoke] ${s}\n`);
const check = (label, cond) => {
  log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failed += 1;
};

const baseRoot = {
  id: "root",
  title: "R",
  spec: "s",
  acceptance: [],
  needDecompose: true,
};

/** 造一个「假宿主面 + 已注册工具族」的 apply 实例；services 为 undefined 的项模拟 apply 期不可见 */
async function harness({ services = {}, config = {} } = {}) {
  const seen = { subagentStarts: [], workflowStarts: [], measures: 0 };
  const registry = {
    subagents: {
      getProvider: () => ({ capabilities: { agentOptions: true } }),
      start: async (name, request) => {
        seen.subagentStarts.push({ name, request });
        return {
          id: `child-${seen.subagentStarts.length}`,
          localAgent: { session: { child: true } },
          result: Promise.resolve({
            output: [{ type: "text", text: "子代理产出：调研完成" }],
            stopReason: "completed",
          }),
          dispose: async () => {},
        };
      },
    },
    workflowEngine: {
      start: (request) => {
        seen.workflowStarts.push(request);
        return {
          result: Promise.resolve({
            value: { answer: 42 },
            stopReason: "completed",
          }),
          dispose: async () => {},
        };
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: "ustc", model: "deepseek-flash" }),
    },
    tokenMeter: {
      measure: () => {
        seen.measures += 1;
        return { totalTokens: 1234 };
      },
    },
    ...services,
  };
  const tools = new Map();
  const ctx = {
    tools: { register: (def) => tools.set(def.name, def) },
    provide: () => {},
    effect: () => () => {},
    get: (name) => registry[name],
  };
  await apply(ctx, {
    root: { ...baseRoot },
    commandTimeoutMs: 10_000,
    ...config,
  });
  return { tools, seen };
}

const AGENT = { agent: { fake: "agent" } };
const call = (tools, name, args, exec = AGENT) =>
  tools.get(name).execute(args, exec);

const leaf = (id, executor, title = id) => ({
  id,
  title,
  spec: `做 ${id}`,
  acceptance: [],
  need_decompose: false,
  coverage: {},
  executor,
});

// ── 1）工具族 + subagent（模型 / 预算 / 用量口径）──────────────────────────
{
  const { tools, seen } = await harness();
  check(
    "工具族注册含 task_execute",
    [
      "task_decompose",
      "task_execute",
      "task_implement",
      "task_status",
      "task_stop",
    ].every((n) => tools.has(n)),
  );
  const d = await call(tools, "task_decompose", {
    parent_id: "root",
    children: [
      leaf("c1", {
        kind: "subagent",
        prompt: "调研并给结论",
        model: { provider: "deepseek", model: "deepseek-chat" },
        budget: { maxTokens: 4000 },
      }),
      leaf("c2", { kind: "subagent" }),
    ],
  });
  check("executor 叶子过门禁挂树", d.ok === true);

  const r = await call(tools, "task_execute", { task_id: "c1" });
  check(
    "subagent：证据回填",
    r.ok === true && /子代理产出/.test(String(r.evidence)),
  );
  check(
    "subagent：模型 / 预算 → agentOptions",
    JSON.stringify(seen.subagentStarts[0].request.agentOptions) ===
      JSON.stringify({
        provider: "deepseek",
        model: "deepseek-chat",
        maxTokens: 4000,
      }),
  );
  check(
    "subagent：用量为 pressure 口径且不判超预算",
    r.usage?.tokens === 1234 &&
      r.usage?.tokensKind === "pressure" &&
      r.usage?.overBudget === undefined,
  );
  check(
    "subagent：parent / prompt 透传",
    seen.subagentStarts[0].request.parent === AGENT.agent &&
      seen.subagentStarts[0].request.prompt[0].text === "调研并给结论",
  );
  check("subagent：provider 为 spawn", seen.subagentStarts[0].name === "spawn");

  const r2 = await call(tools, "task_execute", { task_id: "c2" });
  check(
    "未声明模型：不传 agentOptions（保持宿主合并语义）",
    r2.ok === true && seen.subagentStarts[1].request.agentOptions === undefined,
  );
}

// ── 2）command 真跑 /bin/sh ───────────────────────────────────────────────
{
  const { tools } = await harness();
  await call(tools, "task_decompose", {
    parent_id: "root",
    children: [leaf("c1", { kind: "command", command: "echo hi-executor" })],
  });
  const r = await call(tools, "task_execute", { task_id: "c1" });
  check(
    "command：/bin/sh -c 产出回填",
    r.ok === true && /hi-executor/.test(String(r.evidence)),
  );
}

// ── 3）workflow：默认 meta 合并 + 对象证据 ────────────────────────────────
{
  const { tools, seen } = await harness();
  await call(tools, "task_decompose", {
    parent_id: "root",
    children: [
      leaf(
        "w1",
        {
          kind: "workflow",
          script: "return { a: 1 }",
          meta: { name: "自定义名" },
        },
        "标题来自帧",
      ),
    ],
  });
  const r = await call(tools, "task_execute", { task_id: "w1" });
  check(
    "workflow：对象返回值 → 文本证据",
    r.ok === true && /"answer": 42/.test(String(r.evidence)),
  );
  check(
    "workflow：默认 meta 生成 / 合并（description 由帧标题补齐）",
    JSON.stringify(seen.workflowStarts[0].meta) ===
      JSON.stringify({ name: "自定义名", description: "标题来自帧" }),
  );
  check("workflow：parent 透传", seen.workflowStarts[0].parent === AGENT.agent);
}

// ── 4）workflow 失败分类：同步抛错（声明错误）不打回 ──────────────────────
{
  const { tools } = await harness({
    services: {
      workflowEngine: {
        start: () => {
          throw new Error("META_INVALID: bad meta");
        },
      },
    },
  });
  await call(tools, "task_decompose", {
    parent_id: "root",
    children: [leaf("w2", { kind: "workflow", script: "return 1" })],
  });
  const r = await call(tools, "task_execute", { task_id: "w2" });
  check(
    "workflow：同步抛错 → 反馈可读且不计重试",
    r.ok === false &&
      /请修 script \/ meta 声明/.test(String(r.feedback)) &&
      /META_INVALID/.test(String(r.feedback)),
  );
  check("workflow：同步抛错 → next 仍指本帧（状态未改）", r.next === "w2");
}

// ── 5）workflow cancelled → 反馈可读 ──────────────────────────────────────
{
  const { tools } = await harness({
    services: {
      workflowEngine: {
        start: () => ({
          result: Promise.resolve({
            value: undefined,
            stopReason: "cancelled",
          }),
          dispose: async () => {},
        }),
      },
    },
  });
  await call(tools, "task_decompose", {
    parent_id: "root",
    children: [leaf("w3", { kind: "workflow", script: "return 1" })],
  });
  const r = await call(tools, "task_execute", { task_id: "w3" });
  check(
    "workflow：cancelled 反馈可读",
    r.ok === false && /workflow cancelled/.test(String(r.feedback)),
  );
}

// ── 6）宿主服务惰性解析（插件 ctx 不可见时从工具执行 ctx 解析）────────────
{
  const { tools } = await harness({
    services: {
      subagents: undefined,
      workflowEngine: undefined,
      agentDefaultModel: undefined,
      tokenMeter: undefined,
    },
  });
  const execWithServices = {
    agent: { lazy: true },
    get: (name) =>
      name === "workflowEngine"
        ? {
            start: () => ({
              result: Promise.resolve({
                value: { lazy: "ok" },
                stopReason: "completed",
              }),
              dispose: async () => {},
            }),
          }
        : name === "subagents"
          ? {
              getProvider: () => ({ capabilities: { agentOptions: true } }),
              start: async () => ({
                id: "child-lazy",
                localAgent: { session: {} },
                result: Promise.resolve({
                  output: [{ type: "text", text: "lazy-ok" }],
                  stopReason: "completed",
                }),
                dispose: async () => {},
              }),
            }
          : undefined,
  };
  await call(
    tools,
    "task_decompose",
    {
      parent_id: "root",
      children: [
        leaf("lz1", { kind: "workflow", script: "return 1" }),
        leaf("lz2", { kind: "subagent" }),
      ],
    },
    execWithServices,
  );
  const wf = await call(
    tools,
    "task_execute",
    { task_id: "lz1" },
    execWithServices,
  );
  const sa = await call(
    tools,
    "task_execute",
    { task_id: "lz2" },
    execWithServices,
  );
  check(
    "惰性解析：workflow 发起成功",
    wf.ok === true && /"lazy": "ok"/.test(String(wf.evidence)),
  );
  check(
    "惰性解析：subagent 发起成功",
    sa.ok === true && /lazy-ok/.test(String(sa.evidence)),
  );
}

// ── 7）证据截断边界 ──────────────────────────────────────────────────────
{
  const cut = truncateEvidence("a".repeat(MAX_EVIDENCE_CHARS + 100));
  check(
    "截断：超限标注原始长度 + 未超限原样",
    cut.length < MAX_EVIDENCE_CHARS + 100 &&
      /已截断，原始 \d+ 字符/.test(cut) &&
      truncateEvidence("short") === "short",
  );
}

// ── 8）execute → stop → join 整树 done ───────────────────────────────────
{
  const { tools } = await harness({
    config: {
      root: {
        ...baseRoot,
        acceptance: [
          {
            id: "r-q",
            check: "示例命令通过",
            level: "mechanical",
            command: "true",
          },
        ],
      },
    },
  });
  await call(tools, "task_decompose", {
    parent_id: "root",
    children: [
      {
        ...leaf("c1", { kind: "command", command: "echo ok" }),
        coverage: { "r-q": ["c1"] },
      },
    ],
  });
  const r = await call(tools, "task_execute", { task_id: "c1" });
  check("execute：证据回填且下一步仍是本帧", r.ok === true && r.next === "c1");
  const stop = await call(tools, "task_stop", { task_id: "c1" });
  check("stop：验收通过并 join", stop.ok === true && stop.next === null);
  const status = await call(tools, "task_status", {});
  check(
    "status：整树 done 且暴露 executorKind",
    status.tree[0].status === "done" &&
      status.tree[0].children[0].executorKind === "command",
  );
}

log(failed === 0 ? "SMOKE_PASS" : `SMOKE_FAIL failures=${failed}`);
if (failed > 0) process.exitCode = 1;
