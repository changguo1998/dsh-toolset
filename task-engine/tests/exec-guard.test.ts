// tests/exec-guard.test.ts — 执行期命令复查（security-guard 服务面）
//
// 引擎执行命令的两条缝都补了「执行前复查」：① executor 的 command 后端（task_execute
// 发起前）；② mechanical 验收（`acc.command`，含**不在** task_decompose 登记表里的
// `root.acceptance[].command`）。另覆盖 fail-open 粒度：guard 未挂载 / 复查抛错 → 放行 +
// 只告警一次（不刷屏，也不让既有流程失败）。
//
// 危险词一律分片拼接：仓库内不出现真实危险命令 / 提权词字面量。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { judgeAcceptance } from "../src/acceptance.ts";
import { apply, makeCommandGuard } from "../src/main.ts";

/** 危险词分片拼接（不写真实提权词字面量）。 */
const RISKY_WORD = "su" + "do";
/** 假 guard 的规则 id（同样分片拼装）。 */
const RULE_ID = `blacklist-${RISKY_WORD}`;

/** 命中回执（与 security-guard 的 receipt 同形：规则 id + 来源标注行）。 */
function receiptFor(source?: string): string {
  return [
    `[security-guard] 已拦截：命令命中黑名单规则「${RULE_ID}」。`,
    `[security-guard] 命令复查来源：${source ?? "?"}。`,
  ].join("\n");
}

/**
 * 「危险」命令（拼接构造）：危险词只出现在 shell 注释里 —— 真被执行时效果无害
 * （创建探针文件），故「探针不存在」= 命令未执行。
 */
function riskyCommand(probe: string): string {
  return `touch ${probe} # ${RISKY_WORD} --version`;
}

/** 假 guard 复查面：记录每次调用；命中危险词即回执（否则放行）。 */
function denyRisky(
  calls: { command: string; source?: string }[],
): (command: string, source?: string) => string | null {
  return (command, source) => {
    calls.push({ command, ...(source === undefined ? {} : { source }) });
    return command.includes(RISKY_WORD) ? receiptFor(source) : null;
  };
}

interface ToolLike {
  name: string;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
}

/**
 * 经 apply 真接线建工具台（工具经 `tools.register` 收集，走真实 main.ts 的 executor /
 * 验收接线）；`guardFace` 提供 `ctx.get("guard")` 的服务面，缺省 = 未挂载。
 */
async function bench(opts: {
  rootAcceptanceCommand: string;
  guardFace?: (command: string, source?: string) => string | null;
}): Promise<{
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}> {
  const tools = new Map<string, ToolLike>();
  await apply(
    {
      tools: {
        register: (def: unknown) => {
          const tool = def as ToolLike;
          tools.set(tool.name, tool);
        },
      },
      provide: () => {},
      effect: () => () => {},
      get: (name: string) =>
        name === "guard" && opts.guardFace !== undefined
          ? { inspectCommand: opts.guardFace }
          : undefined,
    },
    {
      root: {
        title: "R",
        spec: "s",
        acceptance: [
          {
            id: "r-q",
            check: "父验收",
            level: "mechanical",
            command: opts.rootAcceptanceCommand,
          },
        ],
      },
    },
  );
  return {
    call: async (name, args) => {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`工具未注册：${name}`);
      return await tool.execute(args, {
        agent: { id: "agent-1", session: { id: "s1" } },
      });
    },
  };
}

/** 叶子声明（缺省 model 后端；给了 `executor` 即声明对应后端）。 */
function leaf(
  id: string,
  executor?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    title: id,
    spec: `做 ${id}`,
    acceptance: [],
    need_decompose: false,
    coverage: { "r-q": [id] },
    ...(executor === undefined ? {} : { executor }),
  };
}

/** 捕获区间内写往 stderr 的告警（node:test 自身输出走 stdout）。 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const stream = process.stderr as unknown as {
    write: (chunk: string) => boolean;
  };
  const original = stream.write;
  stream.write = (chunk: string): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    stream.write = original;
  }
  return chunks.join("");
}

describe("执行期复查：executor command 后端（D1①）", () => {
  it("危险命令（拼接构造）执行前被拦：未执行、ok:false、回执含规则 id 与来源标注", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-engine-guard-exec-"));
    try {
      const probe = join(dir, "executed.probe");
      const risky = riskyCommand(probe);
      const calls: { command: string; source?: string }[] = [];
      const b = await bench({
        rootAcceptanceCommand: "true",
        guardFace: denyRisky(calls),
      });
      const dec = await b.call("task_decompose", {
        parent_id: "root",
        children: [leaf("c1", { kind: "command", command: risky })],
      });
      assert.equal(dec.ok, true, JSON.stringify(dec));

      const r = await b.call("task_execute", { task_id: "c1" });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.accepted, false);
      assert.equal(
        existsSync(probe),
        false,
        "被拦的命令不得执行（探针不该落地）",
      );
      assert.match(
        String(r.feedback),
        new RegExp(RULE_ID),
        "回执须带规则 id（原文透传）",
      );
      assert.match(
        String(r.feedback),
        /task-engine\{executor\} c1/,
        "回执须带来源标注",
      );
      assert.equal(calls.at(-1)?.command, risky);
      assert.equal(calls.at(-1)?.source, "task-engine{executor} c1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("普通命令照常执行：真 /bin/sh -c 落地探针 + ok:true（复查逐次仍走）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-engine-guard-normal-"));
    try {
      const probe = join(dir, "normal.probe");
      const calls: { command: string; source?: string }[] = [];
      const b = await bench({
        rootAcceptanceCommand: "true",
        guardFace: denyRisky(calls),
      });
      await b.call("task_decompose", {
        parent_id: "root",
        children: [leaf("c1", { kind: "command", command: `touch ${probe}` })],
      });

      const r = await b.call("task_execute", { task_id: "c1" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(existsSync(probe), true, "放行的命令应真的执行");
      assert.equal(calls.at(-1)?.command, `touch ${probe}`);
      assert.equal(calls.at(-1)?.source, "task-engine{executor} c1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("执行期复查：mechanical 验收路径（D1②）", () => {
  it("root.acceptance[].command 执行前被拦：验收不通过、探针不存在、回执带来源标注", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-engine-guard-acc-"));
    try {
      const probe = join(dir, "acceptance.probe");
      const risky = riskyCommand(probe);
      const calls: { command: string; source?: string }[] = [];
      const b = await bench({
        rootAcceptanceCommand: risky,
        guardFace: denyRisky(calls),
      });
      await b.call("task_decompose", {
        parent_id: "root",
        children: [leaf("c1")],
      });
      await b.call("task_implement", { task_id: "c1", result: "产出" });

      // 子帧自身停就绪：join 续体随即判父验收（机械级命令的执行缝在这里）
      const stopChild = await b.call("task_stop", { task_id: "c1" });
      assert.equal(stopChild.ok, true, JSON.stringify(stopChild));
      assert.equal(calls.at(-1)?.command, risky, "join 续体须复查父验收命令");
      assert.equal(calls.at(-1)?.source, "task-engine{acceptance} root");
      assert.equal(existsSync(probe), false, "被拦的验收命令不得执行");

      // 父帧被打回：显式 stop 根帧再判一次（拦一次不改变结论，回执原文即失败原因）
      const stopRoot = await b.call("task_stop", { task_id: "root" });
      assert.equal(stopRoot.ok, false, JSON.stringify(stopRoot));
      assert.match(
        String(stopRoot.feedback),
        new RegExp(RULE_ID),
        "回执须带规则 id",
      );
      assert.match(
        String(stopRoot.feedback),
        /task-engine\{acceptance\} root/,
        "回执须带来源标注（验收路径）",
      );
      assert.equal(calls.at(-1)?.source, "task-engine{acceptance} root");
      assert.equal(existsSync(probe), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("普通验收命令照常执行：join 判过、根帧完成、探针落地", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-engine-guard-acc-ok-"));
    try {
      const probe = join(dir, "acceptance-ok.probe");
      const cmd = `touch ${probe}`;
      const calls: { command: string; source?: string }[] = [];
      const b = await bench({
        rootAcceptanceCommand: cmd,
        guardFace: denyRisky(calls),
      });
      await b.call("task_decompose", {
        parent_id: "root",
        children: [leaf("c1")],
      });
      await b.call("task_implement", { task_id: "c1", result: "产出" });

      const stop = await b.call("task_stop", { task_id: "c1" });
      assert.equal(stop.ok, true, JSON.stringify(stop));
      assert.equal(existsSync(probe), true, "放行的验收命令应真的执行");
      assert.equal(calls.at(-1)?.command, cmd);
      assert.equal(calls.at(-1)?.source, "task-engine{acceptance} root");
      const status = await b.call("task_status", {});
      const tree = status.tree as { status: string }[];
      assert.equal(tree[0]?.status, "done", "根帧验收通过后应完成");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("judgeAcceptance：blocked 回执 → 不通过且回执原文进 feedback（frame 透传执行方）", async () => {
    const seen: (string | undefined)[] = [];
    const verdict = await judgeAcceptance(
      "c1",
      { id: "q1", check: "检查一", level: "mechanical", command: "echo 1" },
      {
        runCommand: async (_cmd, frame) => {
          seen.push(frame);
          return {
            code: 1,
            output: receiptFor("task-engine{acceptance} c1"),
            blocked: true,
          };
        },
        approve: async () => true,
      },
    );
    assert.equal(verdict.pass, false);
    assert.equal(seen[0], "c1", "frame 须透传给执行方（用于来源标注）");
    const feedback = verdict.pass === false ? verdict.feedback : "";
    assert.match(feedback, new RegExp(RULE_ID));
    assert.match(feedback, /task-engine\{acceptance\} c1/);
  });
});

describe("执行期复查：fail-open 粒度（D2）", () => {
  it("guard 未挂载 → 放行 + 只告警一次（多次调用不刷屏）", () => {
    const warns: string[] = [];
    const check = makeCommandGuard({ get: () => undefined }, (m) =>
      warns.push(m),
    );
    assert.equal(check("echo 1", "task-engine{executor} c1"), null);
    assert.equal(check("echo 2", "task-engine{acceptance} root"), null);
    assert.equal(warns.length, 1, `应只告警一次：${JSON.stringify(warns)}`);
    assert.match(warns[0] ?? "", /security-guard 服务不可用/);
  });

  it("复查抛错 → 放行 + 只告警一次（复查仍逐次真调用，不拖垮流程）", () => {
    const warns: string[] = [];
    let calls = 0;
    const check = makeCommandGuard(
      {
        get: () => ({
          inspectCommand: () => {
            calls += 1;
            throw new Error("guard 崩了");
          },
        }),
      },
      (m) => warns.push(m),
    );
    for (let i = 0; i < 3; i += 1) {
      assert.equal(check("echo 1", "task-engine{executor} c1"), null);
    }
    assert.equal(calls, 3, "每次都要真复查（只是告警不重复）");
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /复查异常（按放行处理/);
  });

  it("ctx.get 抛错按缺失处理；非字符串 / 空串回执一律按放行", () => {
    const warns: string[] = [];
    const strict = makeCommandGuard(
      {
        get: () => {
          throw new Error("strict mode");
        },
      },
      (m) => warns.push(m),
    );
    assert.equal(strict("echo 1", "s"), null);
    assert.equal(warns.length, 1, "get 抛错也只告警一次");

    const noWarn = (): void => {
      throw new Error("空串回执不该告警");
    };
    const empty = makeCommandGuard(
      { get: () => ({ inspectCommand: () => "" }) },
      noWarn,
    );
    assert.equal(empty("echo 1", "s"), null);
    const wrongType = makeCommandGuard(
      {
        get: () => ({
          inspectCommand: () => 42 as unknown as string | null,
        }),
      },
      noWarn,
    );
    assert.equal(wrongType("echo 1", "s"), null);
  });

  it("命中 → 回执原文透传，且 inspectCommand 拿到 (command, source)", () => {
    const calls: { command: string; source?: string }[] = [];
    const check = makeCommandGuard(
      { get: () => ({ inspectCommand: denyRisky(calls) }) },
      () => {
        throw new Error("命中 / 放行都不该告警");
      },
    );
    assert.equal(check("echo ok", "s1"), null);
    assert.equal(check(riskyCommand("/tmp/never"), "s2"), receiptFor("s2"));
    assert.deepEqual(calls, [
      { command: "echo ok", source: "s1" },
      { command: riskyCommand("/tmp/never"), source: "s2" },
    ]);
  });

  it("集成：无 guard 服务 → 命令照常执行 + 全程只告警一次", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-engine-guard-nog-"));
    try {
      const p1 = join(dir, "p1.probe");
      const p2 = join(dir, "p2.probe");
      const text = await captureStderr(async () => {
        const b = await bench({ rootAcceptanceCommand: "true" });
        await b.call("task_decompose", {
          parent_id: "root",
          children: [
            leaf("c1", { kind: "command", command: `touch ${p1}` }),
            leaf("c2", { kind: "command", command: `touch ${p2}` }),
          ],
        });
        const r1 = await b.call("task_execute", { task_id: "c1" });
        assert.equal(r1.ok, true, JSON.stringify(r1));
        const r2 = await b.call("task_execute", { task_id: "c2" });
        assert.equal(r2.ok, true, JSON.stringify(r2));
      });
      assert.equal(
        existsSync(p1),
        true,
        "无 guard 时命令照常执行（fail-open）",
      );
      assert.equal(existsSync(p2), true);
      // 只数 guard 复查的告警（同一 bench 里 entail 门也会因缺 subagents 告警，不在本用例范围）
      const warnings = text
        .split("\n")
        .filter((line) => line.includes("security-guard 服务不可用"));
      assert.equal(
        warnings.length,
        1,
        `两次复查只告警一次：${JSON.stringify(warnings)}`,
      );
      assert.match(warnings[0] ?? "", /fail-open/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("集成：guard 复查抛错 → 命令照常执行（不抛到调用方）+ 全程只告警一次", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-engine-guard-throw-"));
    try {
      const p1 = join(dir, "t1.probe");
      const p2 = join(dir, "t2.probe");
      let inspectCalls = 0;
      const text = await captureStderr(async () => {
        const b = await bench({
          rootAcceptanceCommand: "true",
          guardFace: () => {
            inspectCalls += 1;
            throw new Error("guard 崩了");
          },
        });
        await b.call("task_decompose", {
          parent_id: "root",
          children: [
            leaf("c1", { kind: "command", command: `touch ${p1}` }),
            leaf("c2", { kind: "command", command: `touch ${p2}` }),
          ],
        });
        // 复查抛错不得冒泡到工具层：命令照常执行、工具照常返回 ok:true
        const r1 = await b.call("task_execute", { task_id: "c1" });
        assert.equal(r1.ok, true, JSON.stringify(r1));
        const r2 = await b.call("task_execute", { task_id: "c2" });
        assert.equal(r2.ok, true, JSON.stringify(r2));
      });
      assert.equal(inspectCalls, 2, "每次执行前都要真复查");
      assert.equal(existsSync(p1), true, "复查抛错时命令照常执行（fail-open）");
      assert.equal(existsSync(p2), true);
      const warnings = text
        .split("\n")
        .filter((line) => line.includes("security-guard 复查异常"));
      assert.equal(
        warnings.length,
        1,
        `只告警一次：${JSON.stringify(warnings)}`,
      );
      assert.match(warnings[0] ?? "", /按放行处理/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
