/**
 * 集成层: 本包 `apply` 与宿主接线 (假工具面 / 假服务面 / 假提供面 / 假 `effect` 面)。
 *
 * 与单元层的分工: 单元层断工具族与引擎的纯逻辑; 这里走完整接线 —— `apply` 注册工具、
 * 挂 `taskEngine` 查询面、审批链 / 命令复查 / 子代理 / 时钟按名解析, 再经注册面 `execute`
 * 断 canonical 值、`output.render` 投影、状态流转、失败路径与卸载收尾。
 * 时钟用真实 `ManualClock`: 超时与卸载收尾都手控推进, 不依赖真实等待。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { Config } from "../../src/index.ts";
import { assemble, fakeExec, type Assembly } from "../assemble.ts";

/** 工具族名单与顺序 (`createTools` 的产物顺序)。 */
const TOOL_NAMES = [
  "task_decompose",
  "task_implement",
  "task_execute",
  "task_stop",
  "task_status",
];

/** 叶子声明 (缺省 model 后端; 给了 `executor` 即声明对应后端)。 */
function leaf(
  id: string,
  override: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: id,
    spec: `做 ${id}`,
    acceptance: [],
    need_decompose: false,
    coverage: { "r-q": [id] },
    ...override,
  };
}

/** `task_status` 视图节点里本文件用到的字段。 */
interface StatusNode {
  id?: string;
  status?: string;
  rounds?: number;
  children: StatusNode[];
}

/** 捕获一段异步调用的 stderr 告警 (执行期告警不经装配期 warnings)。 */
async function captureStderr<T>(
  run: () => Promise<T>,
): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), out: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

describe("apply 接线: 工具注册面", () => {
  it("注册 5 个任务工具, 名单与顺序稳定, 描述首句齐备", async () => {
    const a = await assemble();
    assert.deepEqual(a.order, TOOL_NAMES);
    for (const name of TOOL_NAMES) {
      const tool = a.tools.get(name);
      assert.ok(tool !== undefined, `缺少工具 ${name}`);
      assert.ok(tool.description.length > 0, `${name} 描述非空`);
      assert.match(tool.description, /^用途: /, `${name} 首句为「用途: 」`);
      assert.equal(typeof tool.execute, "function");
    }
    assert.deepEqual(a.warnings, [], "接线期无告警");
  });

  it("参数编译成 JSON Schema: type/properties/required 齐备, status 无必填", async () => {
    const a = await assemble();
    const decompose = a.tools.get("task_decompose")!;
    assert.equal(decompose.parameters.type, "object");
    assert.deepEqual(Object.keys(decompose.parameters.properties ?? {}), [
      "parent_id",
      "children",
    ]);
    assert.deepEqual(decompose.parameters.required, ["parent_id", "children"]);

    assert.deepEqual(a.tools.get("task_implement")!.parameters.required, [
      "task_id",
      "result",
    ]);
    assert.deepEqual(a.tools.get("task_execute")!.parameters.required, [
      "task_id",
    ]);
    assert.deepEqual(a.tools.get("task_stop")!.parameters.required, [
      "task_id",
    ]);
    const status = a.tools.get("task_status")!;
    assert.deepEqual(status.parameters.properties, {});
    assert.equal(status.parameters.required, undefined, "status 无必填参数");
  });

  it("工具面缺席: 只告警不抛错, 也不提供查询面", async () => {
    const a = await assemble({ tools: "absent" });
    assert.deepEqual(a.order, []);
    assert.ok(
      a.warnings.some((line) => line.includes("ctx.tools 不可用")),
      `应写缺面告警: ${JSON.stringify(a.warnings)}`,
    );
  });
});

describe("apply 接线: 只读查询面", () => {
  it("provide taskEngine: query / frameStack 可读, 初始为未完成", async () => {
    const a = await assemble();
    const service = a.provided.get("taskEngine") as
      | {
          query(): {
            tasks: { id: string }[];
            frameStack: string[];
            activeCount: number;
            isComplete: boolean;
          };
          frameStack(): string[];
        }
      | undefined;
    assert.ok(service !== undefined, "应挂 taskEngine 服务");
    assert.equal(typeof service.query, "function");
    assert.equal(typeof service.frameStack, "function");
    const snapshot = service.query();
    assert.deepEqual(
      snapshot.tasks.map((t) => t.id),
      ["root"],
    );
    assert.deepEqual(snapshot.frameStack, ["root"], "根帧在就绪池");
    assert.equal(snapshot.activeCount, 0);
    assert.equal(snapshot.isComplete, false);
  });
});

describe("canonical 值与状态流转", () => {
  /** 一条机械根验收 + 放行一切的命令复查 (避免 fail-open 留痕混进反馈)。 */
  const clean = (): Promise<Assembly> => assemble({ guard: () => null });

  it("decompose → implement → stop: accepted/next 与终态逐环节可断", async () => {
    const a = await clean();
    const d = await a.call("task_decompose", {
      parent_id: "root",
      children: [leaf("c1")],
    });
    assert.equal(d["ok"], true, JSON.stringify(d));
    assert.equal(d["accepted"], true);
    assert.equal(d["next"], "c1", "下一步指向首个就绪子帧");

    const i = await a.call("task_implement", { task_id: "c1", result: "产物" });
    assert.deepEqual(i, { ok: true });

    const s = await a.call("task_stop", { task_id: "c1" });
    assert.equal(s["ok"], true, JSON.stringify(s));
    assert.equal(s["accepted"], true);
    assert.equal(s["next"], null, "根帧完成后无下一步");
    assert.equal(
      s["feedback"],
      undefined,
      "复查跑过时不该有留痕反馈: " + JSON.stringify(s),
    );

    const status = (await a.call("task_status", {})) as {
      ok: boolean;
      rounds: number;
      tree: StatusNode[];
    };
    assert.equal(status.ok, true);
    assert.equal(status.rounds, 1);
    const root = status.tree[0]!;
    assert.equal(root.status, "done");
    assert.equal(root.children[0]?.id, "c1");
    assert.equal(root.children[0]?.status, "done");

    const query = (
      a.provided.get("taskEngine") as {
        query(): { isComplete: boolean; activeCount: number };
      }
    ).query();
    assert.equal(query.isComplete, true, "查询面与任务树同源");
    assert.equal(query.activeCount, 0);
  });

  it("decompose 走 entail 裁决 run: 请求带 label / prompt / 工具面收窄", async () => {
    const a = await clean();
    await a.call("task_decompose", {
      parent_id: "root",
      children: [leaf("c1")],
    });
    const run = a.subagentStarts.find((s) =>
      s.label.startsWith("task:entail:"),
    );
    assert.ok(run !== undefined, "应发起蕴含裁决 run");
    assert.match(run.prompt, /父任务验收/);
    assert.match(run.prompt, /- c1：c1/);
    assert.deepEqual(
      run.toolFilter,
      { deny: TOOL_NAMES },
      "裁决 run 剥掉本引擎全部 task_* 工具",
    );
    assert.notEqual(run.outputSchema, undefined, "裁决 run 请求结构化信封");
  });
});

describe("output.render 投影", () => {
  it("工具返回值 → 单 text 块, JSON 可回读; 字符串原样, 缺值仍为 string", async () => {
    const a = await assemble({ guard: () => null });
    const d = await a.call("task_decompose", {
      parent_id: "root",
      children: [leaf("c1")],
    });
    const text = a.render("task_decompose", d);
    assert.deepEqual(JSON.parse(text), d, "投影是规范化 JSON, 可回读");

    const status = await a.call("task_status", {});
    const blocks = a.tools.get("task_status")!.output!.render!({}, status);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "text");
    assert.equal(JSON.parse(blocks[0]!.text).rounds, 1);

    assert.equal(a.render("task_status", "纯文本"), "纯文本", "字符串原样");
    assert.equal(
      typeof a.render("task_status", undefined),
      "string",
      "缺值不得产出 text: undefined",
    );
  });
});

describe("失败路径", () => {
  it("参数非法: decompose 缺 children / executor 非法 → 反馈而非抛错", async () => {
    const a = await assemble({ guard: () => null });
    const missing = await a.call("task_decompose", { parent_id: "root" });
    assert.equal(missing["ok"], false);
    assert.match(String(missing["feedback"]), /参数非法/);

    const badExecutor = await a.call("task_decompose", {
      parent_id: "root",
      children: [leaf("c1", { executor: { kind: "workflow" } })],
    });
    assert.equal(badExecutor["ok"], false);
    assert.match(String(badExecutor["feedback"]), /必须给 script/);
    assert.match(String(badExecutor["feedback"]), /子任务「c1」/);
  });

  it("状态机拒绝: 非叶子 execute / 未声明后端 execute / 未知帧 stop", async () => {
    const nonLeafBench = await assemble({ guard: () => null });
    await nonLeafBench.call("task_decompose", {
      parent_id: "root",
      children: [leaf("c1", { need_decompose: true })],
    });
    const nonLeaf = await nonLeafBench.call("task_implement", {
      task_id: "c1",
      result: "产物",
    });
    assert.equal(nonLeaf["ok"], false);
    assert.match(String(nonLeaf["feedback"]), /非叶子/);
    const nonLeafExec = await nonLeafBench.call("task_execute", {
      task_id: "c1",
    });
    assert.equal(nonLeafExec["ok"], false);
    assert.match(String(nonLeafExec["feedback"]), /非叶子/);

    const a = await assemble({ guard: () => null });
    await a.call("task_decompose", {
      parent_id: "root",
      children: [leaf("c2")],
    });
    const noBackend = await a.call("task_execute", { task_id: "c2" });
    assert.equal(noBackend["ok"], false);
    assert.match(String(noBackend["feedback"]), /task_implement/);

    const unknown = await a.call("task_stop", { task_id: "nope" });
    assert.equal(unknown["ok"], false);
    assert.equal(unknown["accepted"], false);
    assert.match(String(unknown["feedback"]), /未知帧/);
  });

  it("机械验收失败: 命令非零退出 → 打回并带退出码与来源", async () => {
    const a = await assemble({
      guard: () => null,
      config: {
        root: {
          title: "R",
          spec: "s",
          acceptance: [
            {
              id: "r-q",
              check: "父验收",
              level: "mechanical",
              command: "exit 7",
            },
          ],
        },
      },
    });
    await a.call("task_decompose", {
      parent_id: "root",
      children: [leaf("c1")],
    });
    await a.call("task_implement", { task_id: "c1", result: "产物" });
    const stop = await a.call("task_stop", { task_id: "c1" });
    assert.equal(stop["ok"], true, "子帧自身通过");
    assert.equal(stop["next"], "root", "父帧被打回, 下一步指向父帧");
    const denied = await a.call("task_stop", { task_id: "root" });
    assert.equal(denied["ok"], false, JSON.stringify(denied));
    assert.match(String(denied["feedback"]), /退出码 7/);
    assert.match(String(denied["feedback"]), /父验收/);
  });
});

describe("审批链接线 (human 级验收)", () => {
  /** human 级根验收 + 放行命令复查。 */
  const humanRoot: NonNullable<Config["root"]> = {
    title: "R",
    spec: "s",
    acceptance: [{ id: "r-q", check: "父验收", level: "human" }],
  };

  /** 跑到「子帧停、join 判父验收」这一步 (exec 透传给工具执行上下文)。 */
  async function reachApproval(
    a: Assembly,
    exec: unknown = fakeExec(),
  ): Promise<Record<string, unknown>> {
    await a.call("task_decompose", {
      parent_id: "root",
      children: [leaf("c1")],
    });
    await a.call("task_implement", { task_id: "c1", result: "产物" }, exec);
    return await a.call("task_stop", { task_id: "c1" }, exec);
  }

  it("allowed-once: 父帧完成; 请求带 agent / toolName / 理由", async () => {
    const a = await assemble({
      guard: () => null,
      approval: "allowed-once",
      config: { root: humanRoot },
    });
    const exec = fakeExec("agent-9", "s9");
    const stop = await reachApproval(a, exec);
    assert.equal(stop["ok"], true, JSON.stringify(stop));
    assert.equal(stop["next"], null, "根帧经人工批准后完成");
    assert.equal(a.approvalRequests.length, 1);
    const request = a.approvalRequests[0]!;
    assert.equal(request.toolName, "task_stop");
    assert.equal(request.reason, "父验收");
    assert.deepEqual(request.agent, exec.agent, "请求归属当前工具执行的 agent");
  });

  it("denied: 父帧打回, 显式 stop 根帧给出 fail-closed 文案", async () => {
    const a = await assemble({
      guard: () => null,
      approval: "denied",
      config: { root: humanRoot },
    });
    const stop = await reachApproval(a);
    assert.equal(stop["next"], "root", "人工拒绝后下一步指向父帧");
    const root = await a.call("task_stop", { task_id: "root" });
    assert.equal(root["ok"], false, JSON.stringify(root));
    assert.match(String(root["feedback"]), /未获批准/);
    assert.match(String(root["feedback"]), /fail-closed/);
  });

  it("审批面抛错: 按拒绝处理并只在告警里留痕", async () => {
    const a = await assemble({
      guard: () => null,
      approval: "throw",
      config: { root: humanRoot },
    });
    const { result, out } = await captureStderr(async () => {
      await reachApproval(a);
      return await a.call("task_stop", { task_id: "root" });
    });
    assert.equal(result["ok"], false);
    assert.match(String(result["feedback"]), /未获批准/);
    assert.match(out, /approval\.request 失败/, "告警留痕: " + out);
  });
});

describe("服务面: 时钟统一面", () => {
  it("clock 可用: 不回落、不告警, scope 造绑定与不绑定两组", async () => {
    const a = await assemble();
    assert.ok(a.clock !== undefined);
    assert.equal(a.clockScopes.length, 2, "scoped + detached 各一次");
    assert.equal(a.clockScopes[1], undefined, "detached 不绑定 ctx");
    assert.equal(typeof a.clockScopes[0], "object");
    assert.ok(
      !a.warnings.some((line) => line.includes("clock 服务不可用")),
      "有 clock 时不得回落",
    );
  });

  it("clock 缺席 / 形状不符: 回落进程内定时器, 每个实例只告警一次", async () => {
    for (const clock of ["absent", "broken"] as const) {
      const a = await assemble({ clock });
      assert.equal(a.clock, undefined);
      const hits = a.warnings.filter((line) =>
        line.includes("clock 服务不可用"),
      );
      assert.equal(hits.length, 1, `clock=${clock}: ${JSON.stringify(hits)}`);
    }
  });
});

describe("卸载收尾", () => {
  it("effect 注销: 写最终快照, 事件流含 root-created / node-expanded / step-verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-engine-integ-"));
    const snapshotPath = join(dir, "snapshot.json");
    try {
      const a = await assemble({
        guard: () => null,
        snapshotPath,
        config: {
          root: {
            title: "R",
            spec: "s",
            acceptance: [
              {
                id: "r-q",
                check: "父验收",
                level: "mechanical",
                command: "true",
              },
            ],
          },
        },
      });
      await a.call("task_decompose", {
        parent_id: "root",
        children: [leaf("c1")],
      });
      await a.unload();

      const events = a.events();
      assert.ok(events.length > 0, "卸载后应有事件流快照");
      assert.deepEqual(
        events.map((e) => e.seq),
        events.map((_, index) => index + 1),
        "事件序号连续",
      );
      assert.equal(events[0]?.type, "plan/root-created");
      const expanded = events.find((e) => e.type === "plan/node-expanded");
      assert.ok(expanded !== undefined, "应有 node-expanded 事件");
      assert.equal(expanded["parent"], "root");
      assert.deepEqual(
        (expanded["children"] as { id: string }[]).map((c) => c.id),
        ["c1"],
      );
      const verdict = events.find(
        (e) => e.type === "plan/step-verdict" && e["frame"] === "root",
      );
      assert.equal(verdict?.["accepted"], true, "分解裁决入事件流");
      assert.equal(verdict?.["next"], "c1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("卸载即收尾在途裁决 run: 按超时中止, 不真等; 无残留排期", async () => {
    const a = await assemble({ subagents: "hanging" });
    assert.ok(a.clock !== undefined);
    const running = a.call("task_decompose", {
      parent_id: "root",
      children: [leaf("c1")],
    });
    assert.equal(a.clock.pending, 1, "裁决 run 的超时已排期 (假时钟可断)");

    const { result, out } = await captureStderr(async () => {
      await a.unload();
      return await running;
    });
    assert.equal(
      result["ok"],
      true,
      `环境故障不烧门禁: ${JSON.stringify(result)}`,
    );
    assert.equal(result["accepted"], true);
    assert.match(out, /entail run 不可用/, "跳过语义门要留痕: " + out);
    assert.equal(a.clock.pending, 0, "收尾后无残留排期");
  });
});
