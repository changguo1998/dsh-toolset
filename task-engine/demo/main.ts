// demo/main.ts — mock demo：无 DSH 依赖的脚本化模型，驱动引擎走通
//
// 演示链路（对齐 BACKLOG #1-#4 验收）：
//   decompose（门禁越级拒绝带反馈打回 → 重新拆）→ implement → stop
//   （mechanical 命令退出码 + human 审批链【先拒后批，证明打回重试】），
//   join 续体逐级向上合取复核，最终整树 done。非交互、自断言、退出码收尾。

import { TaskEngine } from "../src/engine.ts";
import { createTools } from "../src/tools.ts";
import type { NestedTaskItem } from "../src/types.ts";

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
