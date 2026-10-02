// tests/engine.test.ts — TaskStack 引擎：状态机、就绪池、join、bounded retry、
// fan-out 有界并发、语义验收 audit、step 裁决、语义蕴含、abort 恢复
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TaskEngine,
  resumeFromSnapshot,
  type ExecuteOutcome,
  type ExecuteRequest,
  type ExecutorRunner,
} from "../src/engine.ts";
import type { AcceptanceHooks } from "../src/acceptance.ts";
import type { ChildSpec, FrameId, LoggedPlanEvent } from "../src/types.ts";

const mech = (
  id: string,
  command = "true",
): { id: string; check: string; level: "mechanical"; command: string } => ({
  id,
  check: `验收 ${id}`,
  level: "mechanical",
  command,
});

function makeHooks(over?: Partial<AcceptanceHooks>): AcceptanceHooks {
  return {
    runCommand: async (cmd) =>
      cmd === "true" ? { code: 0 } : { code: 1, output: "fail" },
    approve: async () => true,
    ...over,
  };
}

function leafChild(
  id: FrameId,
  spec: string,
  coverage?: Record<string, FrameId[]>,
  acceptance = [] as ChildSpec["acceptance"],
): ChildSpec {
  return {
    id,
    title: id,
    spec,
    acceptance,
    needDecompose: false,
    coverage: coverage ?? {},
  };
}
describe("executor 执行扩展（① 发起 / ② 计量）", () => {
  const leafWith = (
    id: FrameId,
    executor: ChildSpec["executor"],
  ): ChildSpec => ({ ...leafChild(id, "做 C1", { "r-q": [id] }), executor });

  const newEngine = (executor?: ExecutorRunner): TaskEngine =>
    new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...makeHooks(),
      ...(executor === undefined ? {} : { executor }),
    });

  it("成功：证据回填 + frame-executed 记录 + 随后 stop 完成整树", async () => {
    const e = newEngine();
    await e.decompose("root", [
      leafWith("c1", { kind: "command", command: "echo hi" }),
    ]);
    assert.equal(e.nextReady(), "c1");
    const r = await e.execute("c1", async (req: ExecuteRequest) => {
      assert.equal(req.executor.kind, "command");
      assert.equal(req.spec, "做 C1");
      return {
        ok: true,
        result: "命令输出：hi",
        tokens: 1200,
        model: "deepseek/deepseek-chat",
      };
    });
    assert.equal(r.ok, true);
    assert.equal(r.next, "c1", "回填证据后仍需对本帧 stop 验收");
    assert.match(r.evidence ?? "", /命令输出/);
    assert.deepEqual(r.usage, { tokens: 1200 });
    assert.equal(e.frames().get("c1")?.result, "命令输出：hi");
    const executed = e.log.filter((ev) => ev.type === "plan/frame-executed");
    assert.equal(executed.length, 1);
    const ev = executed[0] as Extract<
      LoggedPlanEvent,
      { type: "plan/frame-executed" }
    >;
    assert.equal(ev.executor, "command");
    assert.equal(ev.model, "deepseek/deepseek-chat");
    assert.equal(ev.tokens, 1200);
    assert.equal(e.nested()[0]?.children[0]?.executorKind, "command");
    assert.ok((await e.stop("c1")).ok);
    assert.ok(e.isComplete());
  });

  it("未注入适配器 → fail-closed（不打回、不增重试计数）", async () => {
    const e = newEngine();
    await e.decompose("root", [leafWith("c1", { kind: "subagent" })]);
    const r = await e.execute("c1");
    assert.equal(r.ok, false);
    assert.match(r.feedback ?? "", /未注入 executor 适配器/);
    assert.equal(e.frames().get("c1")?.retryCount, 0);
  });

  it("未声明 executor / 声明 model → 提示改用 task_implement", async () => {
    const e = newEngine(async () => ({ ok: true, result: "x" }));
    await e.decompose("root", [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
      {
        ...leafChild("c2", "做 C2", { "r-q": ["c2"] }),
        executor: { kind: "model" },
      },
    ]);
    const r1 = await e.execute("c1");
    assert.equal(r1.ok, false);
    assert.match(r1.feedback ?? "", /task_implement/);
    const r2 = await e.execute("c2");
    assert.equal(r2.ok, false);
    assert.match(r2.feedback ?? "", /task_implement/);
  });

  it("执行失败 → 带反馈打回；达 maxRetries 置 failed 且 next=null", async () => {
    const e = newEngine();
    await e.decompose("root", [
      leafWith("c1", { kind: "command", command: "false" }),
    ]);
    const fail = async (): Promise<ExecuteOutcome> => ({
      ok: false,
      feedback: "命令退出码 1",
    });
    const r1 = await e.execute("c1", fail);
    assert.equal(r1.ok, false);
    assert.equal(r1.next, "c1", "打回：本帧重做");
    assert.equal(e.frames().get("c1")?.retryCount, 1);
    await e.execute("c1", fail);
    const r3 = await e.execute("c1", fail);
    assert.equal(e.frames().get("c1")?.status, "failed");
    assert.equal(r3.next, null);
  });

  it("超预算只标注不打回（后端权威信号 → usage.overBudget）", async () => {
    const e = newEngine();
    await e.decompose("root", [
      leafWith("c1", { kind: "subagent", budget: { maxTokens: 100 } }),
    ]);
    const r = await e.execute("c1", async () => ({
      ok: true,
      result: "产出",
      tokens: 150,
      overBudget: true,
    }));
    assert.equal(r.ok, true, "超预算不打回");
    assert.deepEqual(r.usage, { tokens: 150, overBudget: true });
    const ev = e.log.find((x) => x.type === "plan/frame-executed") as
      { overBudget?: boolean } | undefined;
    assert.equal(ev?.overBudget, true);
  });

  it("retryable=false（声明 / 环境问题）：不打回、不计重试、不改状态", async () => {
    const e = newEngine();
    await e.decompose("root", [
      leafWith("c1", { kind: "workflow", script: "return 1" }),
    ]);
    const r = await e.execute("c1", async () => ({
      ok: false,
      retryable: false,
      feedback: "workflow 无法开始（请修 script / meta 声明）：META_INVALID",
    }));
    assert.equal(r.ok, false);
    assert.equal(r.next, "c1");
    assert.equal(e.frames().get("c1")?.retryCount, 0, "不计重试");
    assert.equal(e.frames().get("c1")?.status, "pending", "帧状态不变");
    const ev = e.log.find((x) => x.type === "plan/frame-executed") as
      { retryable?: boolean } | undefined;
    assert.equal(ev?.retryable, false, "事件留痕 retryable=false");
  });

  it("structured：结构化产出记入 frame-executed（证据正文仍为文本）", async () => {
    const e = newEngine();
    await e.decompose("root", [
      leafWith("c1", { kind: "workflow", script: "return { a: 1 }" }),
    ]);
    const r = await e.execute("c1", async () => ({
      ok: true,
      result: '{\n  "a": 1\n}',
      structured: { a: 1 },
    }));
    assert.equal(r.ok, true);
    assert.equal(e.frames().get("c1")?.result, '{\n  "a": 1\n}');
    const ev = e.log.find((x) => x.type === "plan/frame-executed") as
      { structured?: unknown } | undefined;
    assert.deepEqual(ev?.structured, { a: 1 });
  });

  it("pressure 口径不参与 overBudget 判定（真机误报修复）", async () => {
    const e = newEngine();
    await e.decompose("root", [
      leafWith("c1", { kind: "subagent", budget: { maxTokens: 256 } }),
    ]);
    const r = await e.execute("c1", async () => ({
      ok: true,
      result: "子代理可用。",
      tokens: 19413,
      tokensKind: "pressure" as const,
      model: "ustc/deepseek-flash（宿主默认）",
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.usage, { tokens: 19413, tokensKind: "pressure" });
    const ev = e.log.find((x) => x.type === "plan/frame-executed") as
      { tokensKind?: string; overBudget?: boolean } | undefined;
    assert.equal(ev?.tokensKind, "pressure");
    assert.equal(ev?.overBudget, undefined, "pressure 口径不判超预算");
  });

  it("overBudget 只认后端权威信号（声明预算时采纳 / 未超不标）", async () => {
    const over = newEngine();
    await over.decompose("root", [
      leafWith("c1", { kind: "subagent", budget: { maxTokens: 256 } }),
    ]);
    const r1 = await over.execute("c1", async () => ({
      ok: true,
      result: "产出。",
      tokens: 3210,
      tokensKind: "usage" as const,
      overBudget: true,
    }));
    assert.deepEqual(r1.usage, {
      tokens: 3210,
      tokensKind: "usage",
      overBudget: true,
    });
    const ev1 = over.log.find((x) => x.type === "plan/frame-executed") as
      { tokensKind?: string; overBudget?: boolean } | undefined;
    assert.equal(ev1?.tokensKind, "usage");
    assert.equal(ev1?.overBudget, true);

    const under = newEngine();
    await under.decompose("root", [
      leafWith("c1", { kind: "subagent", budget: { maxTokens: 256 } }),
    ]);
    const r2 = await under.execute("c1", async () => ({
      ok: true,
      result: "产出。",
      tokens: 999,
      tokensKind: "usage" as const,
      overBudget: false,
    }));
    assert.equal(
      r2.usage?.overBudget,
      false,
      "未触顶：后端给 false 就记 false",
    );
  });

  it("tokens 数值不参与判定（大字面量也不判）/ 未声明预算不采纳信号", async () => {
    const e = newEngine();
    await e.decompose("root", [
      leafWith("c1", { kind: "subagent", budget: { maxTokens: 256 } }),
    ]);
    const r = await e.execute("c1", async () => ({
      ok: true,
      result: "产出。",
      tokens: 999999,
      tokensKind: "usage" as const,
    }));
    const ev = e.log.find((x) => x.type === "plan/frame-executed") as
      { overBudget?: boolean } | undefined;
    assert.equal(
      ev?.overBudget,
      undefined,
      "无权威信号不判（tokens 只是信息量）",
    );

    const noBudget = newEngine();
    await noBudget.decompose("root", [leafWith("c1", { kind: "subagent" })]);
    const r2 = await noBudget.execute("c1", async () => ({
      ok: true,
      result: "产出。",
      overBudget: true,
    }));
    assert.equal(r2.usage?.overBudget, undefined, "未声明预算 → 不采纳信号");
  });

  it("非叶子 execute → 拒绝", async () => {
    const e = newEngine(async () => ({ ok: true, result: "x" }));
    const r = await e.execute("root");
    assert.equal(r.ok, false);
    assert.match(r.feedback ?? "", /非叶子/);
  });
});

describe("TaskEngine 全链路", () => {
  it("decompose → implement → stop(mechanical) → join 整树完成", async () => {
    const hooks = makeHooks();
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...hooks,
    });
    const d = await e.decompose("root", [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
    ]);
    assert.ok(d.ok);
    const id = e.nextReady();
    assert.equal(id, "c1");
    assert.ok(e.implement("c1", "产物").ok);
    const stop = await e.stop("c1");
    assert.ok(stop.ok);
    assert.equal(e.frames().get("c1")?.status, "done");
    assert.equal(e.root().status, "done");
    assert.equal(e.isComplete(), true);
  });

  it("就绪池 DFS 先序：第一个子任务先出", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...makeHooks(),
    });
    const children: ChildSpec[] = [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
      leafChild("c2", "做 C2", { "r-q": ["c2"] }),
    ];
    assert.ok((await e.decompose("root", children)).ok);
    assert.equal(e.nextReady(), "c1");
    assert.equal(e.nextReady(), "c2");
    // root 构造时也在池中（pending），子任务完成后才轮到它
    assert.equal(e.nextReady(), "root");
    assert.equal(e.nextReady(), undefined);
  });

  it("implement 非叶子被拒；stop 未 implement 的叶子被拒", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      ...makeHooks(),
    });
    assert.equal(e.implement("root", "x").ok, false);
    assert.ok((await e.decompose("root", [leafChild("c1", "做 C1")])).ok);
    e.nextReady();
    const stop = await e.stop("c1");
    assert.equal(stop.ok, false);
    assert.match(stop.feedback ?? "", /尚未 implement/);
  });

  it("机械验收失败 → 带反馈打回；达上限 → failed", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      gate: { maxRetries: 3 },
      ...makeHooks(),
    });
    assert.ok(
      (
        await e.decompose("root", [
          leafChild("c1", "做 C1", {}, [mech("q", "false")]),
        ])
      ).ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "x").ok);
    const r1 = await e.stop("c1");
    assert.equal(r1.ok, false);
    assert.match(r1.feedback ?? "", /退出码/);
    const r2 = await e.stop("c1");
    assert.equal(r2.ok, false);
    const r3 = await e.stop("c1");
    assert.equal(r3.ok, false);
    assert.equal(e.frames().get("c1")?.status, "failed");
  });

  it("human 验收先拒后批 → 打回重试后完成，retryCount=1", async () => {
    let n = 0;
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      approve: async () => {
        n += 1;
        return n > 1;
      },
    });
    assert.ok(
      (
        await e.decompose("root", [
          leafChild("c1", "做 C1", {}, [
            { id: "h", check: "人工确认", level: "human" as const },
          ]),
        ])
      ).ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "x").ok);
    const first = await e.stop("c1");
    assert.equal(first.ok, false);
    assert.equal(e.frames().get("c1")?.retryCount, 1);
    assert.equal(e.isComplete(), false);
    const second = await e.stop("c1");
    assert.ok(second.ok);
    assert.equal(e.frames().get("c1")?.status, "done");
    assert.equal(e.isComplete(), true);
  });

  it("semantic 级验收缺 audit hook → fail-closed 打回", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      ...makeHooks(),
    });
    assert.ok(
      (
        await e.decompose("root", [
          leafChild("c1", "做 C1", {}, [
            { id: "s", check: "语义", level: "semantic" as const },
          ]),
        ])
      ).ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "x").ok);
    const r = await e.stop("c1");
    assert.equal(r.ok, false);
    assert.match(r.feedback ?? "", /semantic/);
  });
});

describe("TaskEngine 门禁打回 bounded retry", () => {
  it("decompose 连续被拒达上限 → 父帧 failed", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      gate: { maxRetries: 3 },
      ...makeHooks(),
    });
    const bad = leafChild("c1", "先做 A 然后做 B", { "r-q": ["c1"] });
    assert.equal((await e.decompose("root", [bad])).ok, false);
    assert.equal((await e.decompose("root", [bad])).ok, false);
    assert.equal((await e.decompose("root", [bad])).ok, false);
    assert.equal(e.root().status, "failed");
  });
});

describe("TaskEngine 快照恢复", () => {
  it("resumeFromSnapshot 恢复完整后的等价状态", async () => {
    const hooks = makeHooks();
    const e1 = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...hooks,
    });
    assert.ok(
      (
        await e1.decompose("root", [
          leafChild("c1", "做 C1", { "r-q": ["c1"] }),
        ])
      ).ok,
    );
    e1.nextReady();
    assert.ok(e1.implement("c1", "产物").ok);
    assert.ok((await e1.stop("c1")).ok);

    const e2 = resumeFromSnapshot(e1.snapshotText(), hooks);
    assert.deepEqual(e2.nested(), e1.nested());
    assert.equal(e2.isComplete(), true);
  });
});

describe("TaskEngine fan-out 有界并发（BACKLOG #13）", () => {
  it("active 帧数达 maxConcurrent 上限时不再弹栈（不消费候选）", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      gate: { maxConcurrent: 2 },
      ...makeHooks(),
    });
    const children: ChildSpec[] = [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
      leafChild("c2", "做 C2", { "r-q": ["c2"] }),
      leafChild("c3", "做 C3", { "r-q": ["c3"] }),
    ];
    assert.ok((await e.decompose("root", children)).ok);
    // 前两个 claim 成功，第三个被并发上限挡住
    assert.equal(e.nextReady(), "c1");
    assert.equal(e.nextReady(), "c2");
    assert.equal(e.nextReady(), undefined);
    assert.equal(e.activeCount(), 2);
    // 候选未被消费：c3 仍在池中（peek 提示）
    assert.equal(e.peekNextReady(), null); // 达上限时 peek 也返回 null
    // 完成一个帧后释放容量，c3 可被 claim
    assert.ok(e.implement("c1", "产物").ok);
    assert.ok((await e.stop("c1")).ok);
    assert.equal(e.activeCount(), 1);
    assert.equal(e.nextReady(), "c3");
  });

  it("fan-out 下 join 续体语义保持：全部子任务 done 后父帧完成", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      gate: { maxConcurrent: 2 },
      ...makeHooks(),
    });
    const children: ChildSpec[] = [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
      leafChild("c2", "做 C2", { "r-q": ["c2"] }),
    ];
    assert.ok((await e.decompose("root", children)).ok);
    const w1 = e.nextReady();
    const w2 = e.nextReady();
    assert.ok(w1 && w2);
    assert.ok(e.implement(w1, "产物1").ok);
    assert.ok(e.implement(w2, "产物2").ok);
    // 两个执行器并发 stop；最后一个触发 join
    const s1 = await e.stop(w1);
    assert.ok(s1.ok);
    // 第一个 stop 后 join 尚未触发（c2 未 done 前 next 指向 c2 或 root）
    assert.equal(e.root().status, "pending");
    const s2 = await e.stop(w2);
    assert.ok(s2.ok);
    assert.equal(e.root().status, "done");
    assert.equal(e.isComplete(), true);
  });
});

describe("TaskEngine 语义验收 audit（独立 audit run + outputSchema）", () => {
  const semAcc = {
    id: "s-q",
    check: "语义审查：结论与产出一致",
    level: "semantic" as const,
    outputSchema: { type: "object" },
  };

  it("audit hook 通过 + structured 裁决 → stop 完成", async () => {
    const auditCalls: string[] = [];
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      ...makeHooks({
        audit: async (req) => {
          auditCalls.push(req.check);
          return { pass: true, structured: { verdict: "ok" } };
        },
      }),
    });
    assert.ok(
      (await e.decompose("root", [leafChild("c1", "做 C1", {}, [semAcc])])).ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "结论 X").ok);
    const r = await e.stop("c1");
    assert.ok(r.ok);
    assert.deepEqual(auditCalls, ["语义审查：结论与产出一致"]);
    // 裁决进事件流（audit 证据链）
    const verdictEvents = e.log.filter(
      (ev) => ev.type === "plan/acceptance-verdict",
    );
    const sem = verdictEvents.find((ev) => ev.acceptance === "s-q");
    assert.ok(sem);
  });

  it("audit hook 不通过 → 带反馈打回", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      ...makeHooks({
        audit: async () => ({ pass: false, feedback: "结论与产出不一致" }),
      }),
    });
    assert.ok(
      (await e.decompose("root", [leafChild("c1", "做 C1", {}, [semAcc])])).ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "结论 Y").ok);
    const r = await e.stop("c1");
    assert.equal(r.ok, false);
    assert.match(r.feedback ?? "", /不一致/);
  });

  it("声明 outputSchema 但 audit 未返回 structured → fail-closed", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      ...makeHooks({
        audit: async () => ({ pass: true }),
      }),
    });
    assert.ok(
      (await e.decompose("root", [leafChild("c1", "做 C1", {}, [semAcc])])).ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "结论 Z").ok);
    const r = await e.stop("c1");
    assert.equal(r.ok, false);
    assert.match(r.feedback ?? "", /structured/);
  });
});

describe("TaskEngine step 级裁决（BACKLOG #5：accepted/next）", () => {
  it("stop 通过 → accepted=true，next 指向就绪池候选；落 step-verdict 事件", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...makeHooks(),
    });
    assert.ok(
      (
        await e.decompose("root", [
          leafChild("c1", "做 C1", { "r-q": ["c1"] }),
          leafChild("c2", "做 C2", { "r-q": ["c2"] }),
        ])
      ).ok,
    );
    assert.equal(e.nextReady(), "c1");
    assert.ok(e.implement("c1", "产物").ok);
    const s = await e.stop("c1");
    assert.ok(s.ok);
    assert.equal(s.accepted, true);
    assert.equal(s.next, "c2");
    // 事件流携带 step-verdict（§11.2）
    const sv = e.log.filter((ev) => ev.type === "plan/step-verdict");
    const last = sv[sv.length - 1];
    assert.ok(last && last.accepted === true && last.next === "c2");
  });

  it("stop 打回 → accepted=false，next 指向本帧（重做）；终态 next=null", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [] },
      gate: { maxRetries: 2 },
      ...makeHooks(),
    });
    assert.ok(
      (
        await e.decompose("root", [
          leafChild("c1", "做 C1", {}, [mech("q", "false")]),
        ])
      ).ok,
    );
    e.nextReady();
    assert.ok(e.implement("c1", "x").ok);
    const r1 = await e.stop("c1");
    assert.equal(r1.ok, false);
    assert.equal(r1.accepted, false);
    assert.equal(r1.next, "c1"); // 打回重做
    const r2 = await e.stop("c1");
    assert.equal(r2.ok, false);
    const r3 = await e.stop("c1"); // 达上限 → failed
    assert.equal(r3.ok, false);
    assert.equal(r3.next, null); // 终态无下一步
    assert.equal(e.frames().get("c1")?.status, "failed");
  });

  it("decompose 成功 → accepted=true，next 指向第一个子任务", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...makeHooks(),
    });
    const d = await e.decompose("root", [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
      leafChild("c2", "做 C2", { "r-q": ["c2"] }),
    ]);
    assert.ok(d.ok);
    assert.equal(d.accepted, true);
    assert.equal(d.next, "c1");
  });
});

describe("TaskEngine 语义蕴含第二道门（§17.2 entail hook）", () => {
  const parentAcc = [mech("r-q")];

  it("entail hook 不通过 → decompose 拒绝，父帧打回", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: parentAcc },
      gate: { maxRetries: 5 },
      ...makeHooks(),
      entail: async () => ({
        ok: false,
        feedback: "子任务合取不蕴含父验收：缺少对 r-q 的推导",
      }),
    });
    const r = await e.decompose("root", [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
    ]);
    assert.equal(r.ok, false);
    assert.match(r.feedback, /不蕴含/);
    assert.equal(e.frames().get("root")?.status, "pending"); // 打回不终态
    // 机械门禁本可以通过（coverage 完备），拒绝来自第二道
    assert.equal(e.root().children.length, 0);
  });

  it("entail hook 通过 → decompose 挂树", async () => {
    let called = 0;
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: parentAcc },
      ...makeHooks(),
      entail: async (parent, children) => {
        called += 1;
        return {
          ok: children.length > 0 && parent.acceptance.length > 0,
          feedback: "",
        };
      },
    });
    const r = await e.decompose("root", [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
    ]);
    assert.ok(r.ok);
    assert.equal(called, 1);
    assert.deepEqual(e.root().children, ["c1"]);
  });

  it("未配置 entail hook → 只做机械门禁（结构蕴含跳过）", async () => {
    const e = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: parentAcc },
      ...makeHooks(),
    });
    const r = await e.decompose("root", [
      leafChild("c1", "做 C1", { "r-q": ["c1"] }),
    ]);
    assert.ok(r.ok);
  });
});

describe("TaskEngine abort 路径与恢复（turn/end reason=aborted）", () => {
  it("resume 时在途 active 帧回收为 pending，不增重试计数", async () => {
    const hooks = makeHooks();
    const e1 = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...hooks,
    });
    assert.ok(
      (
        await e1.decompose("root", [
          leafChild("c1", "做 C1", { "r-q": ["c1"] }),
        ])
      ).ok,
    );
    e1.nextReady(); // c1 → active（模拟 turn 中止时的在途帧）
    assert.equal(e1.frames().get("c1")?.status, "active");

    // turn/end reason=aborted：进程终止后从快照恢复
    const e2 = resumeFromSnapshot(e1.snapshotText(), hooks);
    const c1 = e2.frames().get("c1");
    assert.equal(c1?.status, "pending"); // 在途帧回收为 pending
    assert.equal(c1?.retryCount, 0); // 不增重试计数（区别于打回）
    assert.equal(c1?.feedback, undefined); // 无打回反馈
    // 恢复后 c1 可重新 claim
    assert.equal(e2.nextReady(), "c1");
    // 全链路可继续完成
    assert.ok(e2.implement("c1", "产物").ok);
    assert.ok((await e2.stop("c1")).ok);
    assert.equal(e2.isComplete(), true);
  });

  it("abort 事件流携带 frame-interrupted（审计证据链）", async () => {
    const hooks = makeHooks();
    const e1 = new TaskEngine({
      root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
      ...hooks,
    });
    assert.ok(
      (
        await e1.decompose("root", [
          leafChild("c1", "做 C1", { "r-q": ["c1"] }),
        ])
      ).ok,
    );
    e1.nextReady();
    const e2 = resumeFromSnapshot(e1.snapshotText(), hooks);
    const interrupted = e2.log.filter(
      (ev) => ev.type === "plan/frame-interrupted",
    );
    assert.equal(interrupted.length, 1);
    assert.ok(interrupted[0] && interrupted[0].frame === "c1");
  });
});

describe("TaskEngine 快照落盘（snapshotPath 周期写）", () => {
  it("配置 snapshotPath 时每次事件后近实时写盘，硬中止后可恢复", async () => {
    const dir = await mkdtemp(join(tmpdir(), "te-snap-"));
    const snapPath = join(dir, "snap.json");
    try {
      const e = new TaskEngine({
        root: { id: "root", title: "R", spec: "s", acceptance: [mech("r-q")] },
        ...makeHooks(),
        snapshotPath: snapPath,
      });
      await e.decompose("root", [leafChild("c1", "做 C1", { "r-q": ["c1"] })]);
      e.nextReady();
      assert.ok(e.implement("c1", "产物").ok);
      // 等串行写盘链落定（fire-and-forget）：轮询「快照含目标事件」而非固定延时——
      // 并行/高负载下写盘可能超过固定窗口（曾读空文件 JSON.parse 报错 flake）
      let onDisk: unknown;
      for (let i = 0; i < 100; i++) {
        try {
          const parsed: unknown = JSON.parse(await readFile(snapPath, "utf8"));
          if (
            Array.isArray(parsed) &&
            (parsed as { type?: string }[]).some(
              (ev) => ev.type === "plan/frame-implemented",
            )
          ) {
            onDisk = parsed;
            break;
          }
        } catch {
          /* 文件尚未写完整，继续等 */
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      const events = onDisk as unknown as { type?: string }[];
      assert.ok(
        Array.isArray(events) && events.length > 0,
        "快照超时未就绪（写盘链未落定）",
      );
      assert.ok(events.some((ev) => ev.type === "plan/frame-implemented"));
      // 模拟硬中止：直接用**已验就绪的快照**恢复（不二次 readFile——fire-and-forget
      // 写盘非原子，重读可能在另一 in-flight 写盘中途截断，导致偶发 Unexpected end）
      const e2 = resumeFromSnapshot(JSON.stringify(onDisk), {
        ...makeHooks(),
      });
      assert.equal(e2.frames().get("c1")?.status, "pending");
      assert.equal(e2.frames().get("c1")?.retryCount, 0);
      assert.equal(e2.nextReady(), "c1");
      assert.ok(e2.implement("c1", "产物").ok);
      assert.ok((await e2.stop("c1")).ok);
      assert.ok(e2.isComplete());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
