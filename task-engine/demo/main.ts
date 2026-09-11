// demo/main.ts — mock demo：无 DSH 依赖的脚本化模型，驱动引擎走通
//
// 演示链路（对齐 BACKLOG #1-#4 验收）：
//   decompose（门禁越级拒绝带反馈打回 → 重新拆）→ implement → stop
//   （mechanical 命令退出码 + human 审批链【先拒后批，证明打回重试】），
//   join 续体逐级向上合取复核，最终整树 done。非交互、自断言、退出码收尾。

import { TaskEngine, resumeFromSnapshot } from "../src/engine.ts";
import { createTools } from "../src/tools.ts";
import type { ChildSpec, NestedTaskItem } from "../src/types.ts";

const log = (s: string): void => {
  process.stdout.write(`[demo] ${s}\n`);
};
let failures = 0;
const check = (label: string, cond: boolean): void => {
  log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};

// mechanical 验收命令表：'true' 通过，其余失败
const runCommand = async (
  cmd: string,
): Promise<{ code: number; output?: string }> => {
  if (cmd === "true") return { code: 0, output: "ok" };
  return { code: 1, output: `unknown cmd: ${cmd}` };
};

// 脚本化审批：root 的 human 首次拒绝（触发打回），后续批准
let rootApprovals = 0;
const approve = async (): Promise<boolean> => {
  rootApprovals += 1;
  return rootApprovals > 1;
};

const engine = new TaskEngine({
  root: {
    id: "root",
    title: "构建示例发布",
    spec: "完成示例任务的端到端发布",
    acceptance: [
      {
        id: "r-mech",
        check: "示例命令通过",
        level: "mechanical",
        command: "true",
      },
      { id: "r-human", check: "人工确认发布", level: "human" },
    ],
    needDecompose: true,
  },
  runCommand,
});

const tools = createTools(engine, { makeApprove: () => approve });
const call = async (
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`不存在工具 ${name}`);
  return t.execute(args);
};

// —— 步骤 0：初始状态 ——
log("root 创建，初始嵌套树：");
renderTree(engine);

// —— 步骤 1：第一次 decompose（越级 → 打回带反馈）——
const badChildren = [
  {
    id: "c1",
    title: "写解析器",
    spec: "实现解析器：`parse(input)` 解析输入并返回结果对象",
    need_decompose: false,
    acceptance: [],
    coverage: { "r-mech": ["c1"] },
  },
];
const bad = await call("task_decompose", {
  parent_id: "root",
  children: badChildren,
});
check(
  "门禁拒绝越级子任务",
  bad.ok === false && String(bad.feedback).includes("越级"),
);
log(`  门禁反馈：${String(bad.feedback)}`);

// —— 步骤 2：第二次 decompose（合法，过门禁挂树）——
const children = [
  {
    id: "c1",
    title: "准备产物",
    spec: "生成构建产物清单",
    need_decompose: false,
    acceptance: [
      { id: "c1-a", check: "清单可读取", level: "mechanical", command: "true" },
    ],
    coverage: { "r-mech": ["c1"], "r-human": ["c2"] },
  },
  {
    id: "c2",
    title: "执行发布",
    spec: "执行发布流程",
    need_decompose: true,
    acceptance: [
      {
        id: "c2-a",
        check: "发布命令通过",
        level: "mechanical",
        command: "true",
      },
    ],
    coverage: { "r-mech": ["c1"], "r-human": ["c2"] },
  },
];
const res = await call("task_decompose", { parent_id: "root", children });
check("第二次 decompose 过门禁挂树", res.ok === true);
log("  decompose root → [c1(叶子), c2(待拆)]");

// —— 步骤 3：处理 c1（叶子）implement → stop(mechanical) ——
let id = engine.nextReady();
check("就绪池先序弹出 c1", id === "c1");
await call("task_implement", { task_id: "c1", result: "产物清单 v1" });
const stopC1 = await call("task_stop", { task_id: "c1" });
check("c1 stop 通过（mechanical 命令退出码 0）", stopC1.ok === true);
log("  IMPLEMENT c1 → 产物清单 v1；STOP c1 mechanical 通过");

// —— 步骤 4：处理 c2（待拆）→ decompose → c2.1 ——
id = engine.nextReady();
check("就绪池先序弹出 c2", id === "c2");
const c2res = await call("task_decompose", {
  parent_id: "c2",
  children: [
    {
      id: "c2.1",
      title: "执行发布命令",
      spec: "执行发布命令",
      need_decompose: false,
      acceptance: [
        {
          id: "c21-a",
          check: "发布通过",
          level: "mechanical",
          command: "true",
        },
      ],
      coverage: { "c2-a": ["c2.1"] },
    },
  ],
});
check("c2 展开挂树", c2res.ok === true);
log("  decompose c2 → [c2.1]");

// —— 步骤 5：处理 c2.1（叶子）→ implement → stop(mechanical) → join c2、root ——
id = engine.nextReady();
check("就绪池先序弹出 c2.1", id === "c2.1");
await call("task_implement", { task_id: "c2.1", result: "发布完成" });
const rootRetryBefore = engine.root().retryCount;
const stopC21 = await call("task_stop", { task_id: "c2.1" });
log("  IMPLEMENT c2.1 → 发布完成；STOP c2.1 mechanical 通过 → join 链触发");
log(
  "  join c2：mechanical 通过 → c2 done；join root：r-mech 通过、r-human 首次被拒 → 打回",
);
check("c2.1 stop 通过", stopC21.ok === true);
check(
  "c2 已 done（join 激活父帧）",
  engine.frames().get("c2")?.status === "done",
);
check("root 首轮被 human 打回（未完成）", engine.isComplete() === false);
const rootFrameAfterReject = engine.frames().get("root");
check(
  "root 打回后 retryCount 较 join 前 +1",
  rootFrameAfterReject?.retryCount === rootRetryBefore + 1,
);
log(`  打回反馈：${String(rootFrameAfterReject?.feedback)}`);

// —— 步骤 6：root 二次 stop（human 通过）→ 整树完成 ——
const stopRoot = await call("task_stop", { task_id: "root" });
check("root 二次 stop 通过（human 批准）", stopRoot.ok === true);
check("整树完成 isComplete()", engine.isComplete() === true);

// —— 步骤 7：最终嵌套树 + 快照 ——
log("最终嵌套任务树：");
renderTree(engine);
const snap = engine.snapshotText();
check("快照可序列化且含 root-created 事件", snap.includes("plan/root-created"));

// —— 第二迭代演示（BACKLOG #5/#13、§17.2、turn/end abort）——

// 演示 8：fan-out 有界并发（maxConcurrent=2，两个 worker 并发，第三个等位）
log("[演示 8] fan-out 有界并发：maxConcurrent=2");
const fan = new TaskEngine({
  root: {
    id: "root",
    title: "并行构建",
    spec: "三个独立模块并行构建",
    acceptance: [
      {
        id: "f-mech",
        check: "三模块均产出",
        level: "mechanical",
        command: "true",
      },
    ],
  },
  gate: { maxConcurrent: 2 },
  runCommand,
});
{
  const r = await fan.decompose("root", [
    {
      id: "w1",
      title: "模块 A",
      spec: "构建模块 A",
      acceptance: [
        { id: "w1-a", check: "A 产出", level: "mechanical", command: "true" },
      ],
      needDecompose: false,
      coverage: { "f-mech": ["w1"] },
    },
    {
      id: "w2",
      title: "模块 B",
      spec: "构建模块 B",
      acceptance: [
        { id: "w2-a", check: "B 产出", level: "mechanical", command: "true" },
      ],
      needDecompose: false,
      coverage: { "f-mech": ["w2"] },
    },
    {
      id: "w3",
      title: "模块 C",
      spec: "构建模块 C",
      acceptance: [
        { id: "w3-a", check: "C 产出", level: "mechanical", command: "true" },
      ],
      needDecompose: false,
      coverage: { "f-mech": ["w3"] },
    },
  ]);
  check("fan-out decompose 挂树", r.ok === true);
  const t1 = fan.nextReady();
  const t2 = fan.nextReady();
  check("前两个 worker 可并发 claim", t1 === "w1" && t2 === "w2");
  check("第三 worker 被并发上限挡住", fan.nextReady() === undefined);
  check("active 帧数 = 2", fan.activeCount() === 2);
  // worker 1 完成，释放容量
  fan.implement("w1", "A 产出");
  await fan.stop("w1");
  check("worker 1 完成后释放容量", fan.activeCount() === 1);
  const t3 = fan.nextReady();
  check("worker 3 获得空位", t3 === "w3");
  fan.implement("w2", "B 产出");
  fan.implement("w3", "C 产出");
  // 两个 worker 并发 stop
  const [s2, s3] = await Promise.all([fan.stop("w2"), fan.stop("w3")]);
  check("两个 worker 并发 stop 均通过", s2.ok === true && s3.ok === true);
  check("fan-out 整树完成", fan.isComplete() === true);
  log("  fan-out 完成：w1/w2/w3 并行，join 根帧");
}

// 演示 9：语义级验收（独立 audit run + outputSchema → structured 裁决）
log("[演示 9] 语义验收：audit hook + outputSchema");
const aud = new TaskEngine({
  root: {
    id: "root",
    title: "研究报告",
    spec: "产出一份研究报告",
    acceptance: [],
  },
  runCommand,
  audit: async (req) => {
    // 模拟独立 audit run：检查结论与产出一致性
    const consistent = (req.result ?? "").includes("结论一致");
    return {
      pass: consistent,
      feedback: consistent ? undefined : "结论与产出不一致",
      structured: {
        verdict: consistent ? "pass" : "fail",
        score: consistent ? 0.9 : 0.2,
      },
    };
  },
});
{
  const r = await aud.decompose("root", [
    {
      id: "s1",
      title: "撰写报告",
      spec: "撰写研究报告",
      acceptance: [
        {
          id: "s1-a",
          check: "语义审查：结论与产出一致",
          level: "semantic",
          outputSchema: {
            type: "object",
            properties: { verdict: { type: "string" } },
          },
        },
      ],
      needDecompose: false,
      coverage: {},
    },
  ]);
  check("audit 场景 decompose 挂树", r.ok === true);
  aud.nextReady();
  // 首次：产出不一致 → audit 不通过
  aud.implement("s1", "初稿");
  const failStop = await aud.stop("s1");
  check("audit 不通过 → 带反馈打回", failStop.ok === false);
  log(`  audit 反馈：${String(failStop.feedback)}`);
  // 修正后重做
  aud.implement("s1", "修订稿，结论一致");
  const passStop = await aud.stop("s1");
  check("audit 通过 → stop 完成", passStop.ok === true);
  const verdicts = aud.log.filter(
    (ev) => ev.type === "plan/acceptance-verdict" && ev.acceptance === "s1-a",
  );
  check("audit 两轮裁决均入事件流（证据链）", verdicts.length === 2);
}

// 演示 10：step 级裁决（accepted/next）
log("[演示 10] step 级裁决：stop 返回 accepted/next");
{
  const sv = new TaskEngine({
    root: {
      id: "root",
      title: "R",
      spec: "s",
      acceptance: [
        { id: "r-q", check: "q", level: "mechanical", command: "true" },
      ],
    },
    runCommand,
  });
  await sv.decompose("root", [
    {
      id: "c1",
      title: "c1",
      spec: "做 C1",
      acceptance: [],
      needDecompose: false,
      coverage: { "r-q": ["c1"] },
    },
    {
      id: "c2",
      title: "c2",
      spec: "做 C2",
      acceptance: [],
      needDecompose: false,
      coverage: { "r-q": ["c2"] },
    },
  ]);
  sv.nextReady();
  sv.implement("c1", "产物");
  const stop1 = await sv.stop("c1");
  check("stop 通过 → accepted=true", stop1.accepted === true);
  check("stop 通过 → next 指向下一候选 c2", stop1.next === "c2");
  log(`  step 裁决：accepted=${stop1.accepted} next=${stop1.next}`);
}

// 演示 11：语义蕴含第二道门（§17.2 entail hook）
log("[演示 11] 语义蕴含门：entail hook");
{
  let entailCalls = 0;
  const et = new TaskEngine({
    root: {
      id: "root",
      title: "R",
      spec: "s",
      acceptance: [
        { id: "r-q", check: "q", level: "mechanical", command: "true" },
      ],
    },
    runCommand,
    entail: async (_parent, _children) => {
      entailCalls += 1;
      // 模拟独立语义运行：第一轮不蕴含，第二轮蕴含
      if (entailCalls === 1) {
        return { ok: false, feedback: "子任务合取不蕴含父验收 r-q" };
      }
      return { ok: true, feedback: "" };
    },
  });
  const etChild = {
    id: "c1",
    title: "c1",
    spec: "做 C1",
    acceptance: [] as ChildSpec["acceptance"],
    needDecompose: false,
    coverage: { "r-q": ["c1"] },
  };
  const fail = await et.decompose("root", [etChild]);
  check("entail 第一轮拒绝 → decompose 打回", fail.ok === false);
  if (!fail.ok) log(`  entail 反馈：${String(fail.feedback)}`);
  const pass = await et.decompose("root", [etChild]);
  check("entail 第二轮通过 → decompose 挂树", pass.ok === true);
  check("entail hook 被调用两次", entailCalls === 2);
}

// 演示 12：turn/end abort 路径与恢复
log("[演示 12] abort 恢复：在途帧回收为 pending");
{
  const ar = new TaskEngine({
    root: {
      id: "root",
      title: "R",
      spec: "s",
      acceptance: [
        { id: "r-q", check: "q", level: "mechanical", command: "true" },
      ],
    },
    runCommand,
  });
  await ar.decompose("root", [
    {
      id: "c1",
      title: "c1",
      spec: "做 C1",
      acceptance: [],
      needDecompose: false,
      coverage: { "r-q": ["c1"] },
    },
  ]);
  ar.nextReady(); // c1 → active（模拟 turn 中止时的在途帧）
  check("中止前 c1 为 active", ar.frames().get("c1")?.status === "active");
  // 进程终止后从快照恢复（resumeFromSnapshot）
  const ar2 = resumeFromSnapshot(ar.snapshotText(), { runCommand });
  check(
    "恢复后 c1 回收为 pending",
    ar2.frames().get("c1")?.status === "pending",
  );
  check("恢复不增重试计数", ar2.frames().get("c1")?.retryCount === 0);
  check("恢复后可重新 claim", ar2.nextReady() === "c1");
  ar2.implement("c1", "产物");
  await ar2.stop("c1");
  check("恢复后全链路可继续完成", ar2.isComplete() === true);
  const interrupted = ar2.log.filter(
    (ev) => ev.type === "plan/frame-interrupted",
  );
  check("abort 事件入流（审计证据链）", interrupted.length === 1);
}

log(failures === 0 ? "DEMO_OK" : `DEMO_FAIL failures=${failures}`);
if (failures > 0) process.exitCode = 1;

function renderTree(e: TaskEngine): void {
  const lines: string[] = [];
  const walk = (item: NestedTaskItem, depth: number): void => {
    lines.push(
      `${"  ".repeat(depth)}[${item.status === "done" ? "x" : " "}] ${item.title}`,
    );
    for (const c of item.children) walk(c, depth + 1);
  };
  for (const t of e.nested()) walk(t, 0);
  for (const l of lines) process.stdout.write(`  ${l}\n`);
}
