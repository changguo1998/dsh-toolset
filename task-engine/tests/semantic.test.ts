// tests/semantic.test.ts — 语义面接线（audit / entail）：经 `apply` 真接线 + 假宿主 `subagents`。
//
// 覆盖：entail 通过/不通过/输出不可解析/服务缺失；audit 通过/不通过/不可解析；
// Config.semantic 开关回到旧行为；裁决 prompt 口径（含验收项 / 产出 / 子项清单）。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  apply,
  auditPrompt,
  entailPrompt,
  judgeToolFilter,
  parseVerdictJson,
  runChildOnce,
} from "../src/main.ts";

/** 一次裁决 run 的脚本：fake `subagents.start` 依次吐出这些文本（用完后重复最后一个）。 */
function fakeSubagents(
  replies: string[],
  options?: {
    hang?: boolean;
    structured?: unknown;
    toolFilter?: boolean;
    /** 带 `toolFilter` 的发起直接抛错（模拟 deny 名单里的名字在全局注册表已失效） */
    failWithFilter?: boolean;
  },
): {
  service: Record<string, unknown>;
  runs: {
    label: string;
    prompt: string;
    outputSchema?: unknown;
    toolFilter?: unknown;
  }[];
  /** 每次 `start` 的尝试（含失败的尝试）：断言「重试」行为用 */
  attempts: { label: string; toolFilter?: unknown }[];
} {
  const runs: {
    label: string;
    prompt: string;
    outputSchema?: unknown;
    toolFilter?: unknown;
  }[] = [];
  const attempts: { label: string; toolFilter?: unknown }[] = [];
  const service = {
    list: () => ["spawn"],
    getProvider: () => ({
      name: "spawn",
      capabilities: {
        agentOptions: true,
        outputSchema: true,
        ...(options?.toolFilter === undefined
          ? {}
          : { toolFilter: options.toolFilter }),
      },
    }),
    start: (_name: string, request: Record<string, unknown>) => {
      const promptText =
        (request["prompt"] as Array<{ text?: string }>)[0]?.text ?? "";
      // 镜像宿主：`request.parent.session` 被无条件解引用（缺 parent 即 TypeError）
      const parent = request["parent"] as { session?: unknown } | undefined;
      if (parent === undefined || parent.session === undefined) {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'session')",
        );
      }
      attempts.push({
        label: String(request["label"]),
        ...(request["toolFilter"] === undefined
          ? {}
          : { toolFilter: request["toolFilter"] }),
      });
      if (
        options?.failWithFilter === true &&
        request["toolFilter"] !== undefined
      ) {
        throw new Error("restrict: 未知的全局工具名（测试用）");
      }
      runs.push({
        label: String(request["label"]),
        prompt: promptText,
        ...(request["outputSchema"] === undefined
          ? {}
          : { outputSchema: request["outputSchema"] }),
        ...(request["toolFilter"] === undefined
          ? {}
          : { toolFilter: request["toolFilter"] }),
      });
      const reply =
        replies[Math.min(runs.length - 1, replies.length - 1)] ?? "";
      return {
        id: `child-${runs.length}`,
        localAgent: { session: { id: `child-${runs.length}` } },
        result:
          options?.hang === true
            ? new Promise(() => {})
            : Promise.resolve({
                stopReason: "completed",
                output: [{ type: "text", text: reply }],
                ...(options?.structured === undefined
                  ? {}
                  : { structured: options.structured }),
              }),
        dispose: async () => {},
      };
    },
  };
  return { service, runs, attempts };
}

interface Bench {
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  runs: {
    label: string;
    prompt: string;
    outputSchema?: unknown;
    toolFilter?: unknown;
  }[];
}

/** 经 apply 真接线建一个工具台（`subagents` 由 `service` 提供；传 undefined 模拟宿主缺面）。 */
async function bench(options: {
  replies?: string[];
  service?: Record<string, unknown> | undefined;
  config?: Record<string, unknown>;
  /** fake provider 是否声明 `toolFilter` 能力位（缺省不声明 = 旧宿主） */
  toolFilter?: boolean;
  /** 指定工具名让 `tools.register` 抛错（模拟注册失败：该名字不得进入 deny 名单） */
  registerFailsFor?: string;
}): Promise<Bench> {
  const fake =
    options.replies === undefined
      ? undefined
      : fakeSubagents(options.replies, { toolFilter: options.toolFilter });
  const service = options.service ?? fake?.service;
  const tools = new Map<
    string,
    {
      execute(
        args: Record<string, unknown>,
        exec?: unknown,
      ): Promise<Record<string, unknown>>;
    }
  >();
  await apply(
    {
      tools: {
        register: (def: unknown) => {
          const tool = def as {
            name: string;
            execute(
              args: Record<string, unknown>,
              exec?: unknown,
            ): Promise<Record<string, unknown>>;
          };
          tools.set(tool.name, tool);
          if (tool.name === options.registerFailsFor) {
            throw new Error("register 失败（测试用）");
          }
        },
      },
      provide: () => {},
      effect: () => () => {},
      get: (name: string) => (name === "subagents" ? service : undefined),
      logger: () => ({ info: () => {}, warn: () => {} }),
    },
    {
      root: {
        title: "R",
        spec: "s",
        acceptance: [{ id: "r-q", check: "父验收", level: "semantic" }],
      },
      ...options.config,
    },
  );
  return {
    runs: fake?.runs ?? [],
    call: async (name, args) => {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`工具未注册：${name}`);
      // 宿主 SubagentStartRequest.parent 是完整 Agent（含 session）：测试里传全形
      return await tool.execute(args, {
        agent: { id: "agent-1", session: { id: "s1" } },
      });
    },
  };
}

const child = (
  id: string,
  level: "semantic" | "mechanical" = "semantic",
): Record<string, unknown> => ({
  id,
  title: id,
  spec: `做 ${id}`,
  coverage: { "r-q": [id] },
  acceptance: [
    {
      id: `${id}-q`,
      check: `验收 ${id}`,
      level,
      ...(level === "mechanical" ? { command: "true" } : {}),
    },
  ],
  need_decompose: false,
});

describe("纯函数：裁决 JSON 解析与 prompt 口径", () => {
  it("parseVerdictJson：裸 JSON / 围栏 JSON / 非对象 / 坏 JSON", () => {
    assert.deepEqual(parseVerdictJson('{"pass": true}'), { pass: true });
    assert.deepEqual(
      parseVerdictJson('```json\n{"ok": false, "feedback": "x"}\n```'),
      {
        ok: false,
        feedback: "x",
      },
    );
    assert.equal(parseVerdictJson("[1,2]"), undefined);
    assert.equal(parseVerdictJson("不是 JSON"), undefined);
  });

  it("auditPrompt：含验收项、产出与输出契约（有 schema 时附 schema）", () => {
    const base = auditPrompt({
      frame: "f1",
      check: "验收 X",
      result: "产出正文",
    });
    assert.match(base, /验收项：验收 X/);
    assert.match(base, /产出正文/);
    assert.match(base, /"pass"/);
    const withSchema = auditPrompt({
      frame: "f1",
      check: "验收 X",
      outputSchema: { type: "object" },
    });
    assert.match(withSchema, /structured/);
    assert.match(withSchema, /\{"type":"object"\}/);
  });

  it("entailPrompt：含父验收与每个子项的规格 / 验收", () => {
    const prompt = entailPrompt(
      {
        id: "root",
        acceptance: [{ id: "r-q", check: "父验收", level: "semantic" }],
      },
      [
        {
          id: "c1",
          title: "子一",
          spec: "规格一",
          acceptance: [
            {
              id: "c1-q",
              check: "验收一",
              level: "mechanical",
              command: "true",
            },
          ],
          needDecompose: false,
          coverage: {},
        },
      ],
    );
    assert.match(prompt, /父验收/);
    assert.match(prompt, /子一/);
    assert.match(prompt, /规格一/);
    assert.match(prompt, /验收一/);
    assert.match(prompt, /"ok"/);
  });
});

describe("entail 语义蕴含门（经 apply 真接线）", () => {
  it("裁决 ok=true → decompose 挂树；prompt 带子项清单", async () => {
    const b = await bench({
      replies: ['{"ok": true, "feedback": "蕴含成立"}'],
    });
    const r = await b.call("task_decompose", {
      parent_id: "root",
      children: [child("c1")],
    });
    assert.equal(r["ok"], true, JSON.stringify(r));
    assert.equal(b.runs.length, 1);
    assert.match(b.runs[0]?.label ?? "", /^task:entail:/);
    assert.match(b.runs[0]?.prompt ?? "", /c1/);
  });

  it("裁决 ok=false → 拒绝并带反馈（gate:entail）", async () => {
    const b = await bench({
      replies: ['{"ok": false, "feedback": "子项推不出父验收"}'],
    });
    const r = await b.call("task_decompose", {
      parent_id: "root",
      children: [child("c1")],
    });
    assert.equal(r["ok"], false);
    assert.match(String(r["feedback"]), /子项推不出父验收/);
  });

  it("裁决 run 不可用 / 输出不可解析 → 跳过该门（不烧重试预算）并留告警", async () => {
    const bad = await bench({ replies: ["我觉得可以"] });
    const r1 = await bad.call("task_decompose", {
      parent_id: "root",
      children: [child("c1")],
    });
    assert.equal(r1["ok"], true, JSON.stringify(r1));

    const noService = await bench({ service: undefined });
    const r2 = await noService.call("task_decompose", {
      parent_id: "root",
      children: [child("c1")],
    });
    assert.equal(r2["ok"], true, JSON.stringify(r2));
  });

  it("Config.semantic.entail=false → 回到旧行为（该门跳过，decompose 直接过）", async () => {
    const b = await bench({
      service: undefined,
      config: { semantic: { entail: false } },
    });
    const r = await b.call("task_decompose", {
      parent_id: "root",
      children: [child("c1")],
    });
    assert.equal(r["ok"], true, JSON.stringify(r));
    assert.equal(b.runs.length, 0);
  });
});

describe("audit 语义验收（经 apply 真接线）", () => {
  it("裁决 pass=true → stop 通过；prompt 带验收项与产出", async () => {
    const b = await bench({
      replies: ['{"ok": true}', '{"pass": true}'],
    });
    await b.call("task_decompose", {
      parent_id: "root",
      children: [child("c1", "mechanical")],
    });
    await b.call("task_implement", { task_id: "c1", result: "实现产出正文" });
    // 叶子通过后 join 到父帧 → 父帧的 semantic 验收在同一调用里跑 audit run（通过则整树完成）
    const leaf = await b.call("task_stop", { task_id: "c1" });
    assert.equal(leaf["ok"], true, JSON.stringify(leaf));
    const status = await b.call("task_status", {});
    assert.equal(
      (status["tree"] as Array<{ status?: string }>)[0]?.status,
      "done",
    );
    const auditRun = b.runs.find((run) => run.label.startsWith("task:audit:"));
    assert.ok(auditRun !== undefined, "应有 audit run");
    assert.match(auditRun.prompt, /验收项：父验收/);
    assert.match(
      auditRun.prompt,
      /实现产出正文/,
      "父帧无自身产出 → 用子帧结论汇总作证据",
    );
  });

  it("裁决 pass=false → 打回并带反馈", async () => {
    const b = await bench({
      replies: ['{"ok": true}', '{"pass": false, "feedback": "产出不含证据"}'],
    });
    await b.call("task_decompose", {
      parent_id: "root",
      children: [child("c1", "mechanical")],
    });
    await b.call("task_implement", { task_id: "c1", result: "无证据的产出" });
    await b.call("task_stop", { task_id: "c1" });
    const r = await b.call("task_stop", { task_id: "root" });
    assert.equal(r["ok"], false, JSON.stringify(r));
    assert.match(String(r["feedback"]), /产出不含证据/);
  });

  it("Config.semantic.audit=false → 回到既有 fail-closed 文案", async () => {
    const b = await bench({
      service: undefined,
      config: { semantic: { audit: false, entail: false } },
    });
    await b.call("task_decompose", {
      parent_id: "root",
      children: [child("c1", "mechanical")],
    });
    await b.call("task_implement", { task_id: "c1", result: "产出" });
    await b.call("task_stop", { task_id: "c1" });
    const r = await b.call("task_stop", { task_id: "root" });
    assert.equal(r["ok"], false, JSON.stringify(r));
    assert.match(String(r["feedback"]), /未配置独立 audit run/);
  });
});

/** 捕获本次调用期间的 `process.stderr.write`（插件 `warn` 是 stderr 直写，不经 logger）。 */
async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; out: string }> {
  const original = process.stderr.write;
  let out = "";
  process.stderr.write = ((chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), out };
  } finally {
    process.stderr.write = original;
  }
}

describe("裁决 run 的工具面收窄（toolFilter：剥掉 task_* 族）", () => {
  const TASK_TOOL_DENY = [
    "task_decompose",
    "task_implement",
    "task_execute",
    "task_stop",
    "task_status",
  ];

  it("provider 声明 toolFilter → entail / audit run 都带 deny = 本引擎工具名", async () => {
    const b = await bench({
      replies: ['{"ok": true}', '{"pass": true}'],
      toolFilter: true,
    });
    await b.call("task_decompose", {
      parent_id: "root",
      children: [child("c1", "mechanical")],
    });
    const entailRun = b.runs.find((r) => r.label.startsWith("task:entail:"));
    assert.deepEqual(
      entailRun?.toolFilter,
      { deny: TASK_TOOL_DENY },
      "蕴含门裁决 run 收窄工具面",
    );
    await b.call("task_implement", { task_id: "c1", result: "产出" });
    await b.call("task_stop", { task_id: "c1" });
    const auditRun = b.runs.find((r) => r.label.startsWith("task:audit:"));
    assert.ok(auditRun !== undefined, "应有 audit run");
    assert.deepEqual(
      auditRun.toolFilter,
      { deny: TASK_TOOL_DENY },
      "语义验收裁决 run 收窄工具面",
    );
  });

  it("provider 未声明 toolFilter → 降级不收窄（裁决照跑）+ stderr 告警留痕", async () => {
    const b = await bench({ replies: ['{"ok": true}'] });
    const { result, out } = await captureStderr(() =>
      b.call("task_decompose", {
        parent_id: "root",
        children: [child("c1")],
      }),
    );
    assert.equal(result["ok"], true, "缺能力位不拒裁决 run: " + out);
    assert.equal(b.runs.length, 1, "裁决仍然发起");
    assert.equal(
      b.runs[0]?.toolFilter,
      undefined,
      "未声明能力位时不传 toolFilter（降级）",
    );
    assert.match(out, /toolFilter 能力位/, "告警留痕: " + out);
  });

  it("无能力位时执行 run 不传 filter 照跑（降级）+ 执行侧告警留痕", async () => {
    const b = await bench({ replies: ['{"ok": true}', "干活完成"] });
    // 挂树（会跑 entail 裁决 run）与执行 run 一起捕获 stderr：两侧共用同一个 once，
    // 故「只打一条告警」本身也是断言项
    const { result, out } = await captureStderr(async () => {
      await b.call("task_decompose", {
        parent_id: "root",
        children: [
          { ...child("c1"), executor: { kind: "subagent", prompt: "干活" } },
        ],
      });
      return await b.call("task_execute", { task_id: "c1" });
    });
    assert.equal(result["ok"], true, "缺能力位不拒执行 run: " + out);
    const run = b.runs.find((r) => r.label === "task:c1");
    assert.ok(run !== undefined, JSON.stringify(b.runs));
    assert.equal(
      run.toolFilter,
      undefined,
      "未声明能力位时不传 toolFilter（降级）",
    );
    assert.match(out, /toolFilter 能力位/, "降级告警留痕: " + out);
    assert.equal(
      (out.match(/toolFilter 能力位/g) ?? []).length,
      1,
      "裁决 / 执行共用同一个实例级 once：只打一条: " + out,
    );
  });

  it("judgeToolFilter：空名单 / 非 task_ 名 → 不收窄（undefined）", () => {
    assert.equal(judgeToolFilter([]), undefined);
    assert.equal(judgeToolFilter(["grep", "read"]), undefined);
    assert.deepEqual(judgeToolFilter(["task_stop", "task_stop", "read"]), {
      deny: ["task_stop"],
    });
  });

  it("能力位显式为 false → 同样降级（不传 toolFilter，裁决照跑）", async () => {
    const b = await bench({ replies: ['{"ok": true}'], toolFilter: false });
    const r = await b.call("task_decompose", {
      parent_id: "root",
      children: [child("c1")],
    });
    assert.equal(r["ok"], true, JSON.stringify(r));
    assert.equal(b.runs.length, 1, "裁决仍然发起");
    assert.equal(b.runs[0]?.toolFilter, undefined, "false 与缺省同路：不收窄");
  });

  it("注册部分失败 → deny 只含注册成功的名字（防宿主 restrict 未知名抛错）", async () => {
    const b = await bench({
      replies: ['{"ok": true}'],
      toolFilter: true,
      registerFailsFor: "task_status",
    });
    await b.call("task_decompose", {
      parent_id: "root",
      children: [child("c1")],
    });
    assert.deepEqual(
      b.runs[0]?.toolFilter,
      {
        deny: ["task_decompose", "task_implement", "task_execute", "task_stop"],
      },
      "注册失败的 task_status 不得进入 deny 名单",
    );
  });

  it("executor（subagent）run 也收窄工具面：deny = 本引擎注册成功的工具名", async () => {
    const b = await bench({
      replies: ['{"ok": true}', "干活完成"],
      toolFilter: true,
    });
    await b.call("task_decompose", {
      parent_id: "root",
      children: [
        { ...child("c1"), executor: { kind: "subagent", prompt: "干活" } },
      ],
    });
    const exec = await b.call("task_execute", { task_id: "c1" });
    assert.equal(exec["ok"], true, JSON.stringify(exec));
    const run = b.runs.find((r) => r.label === "task:c1");
    assert.ok(run !== undefined, JSON.stringify(b.runs));
    assert.deepEqual(
      run.toolFilter,
      { deny: TASK_TOOL_DENY },
      "执行 run 与裁决 run 同口径：剥掉本引擎注册的全部 task_* 族（实际： " +
        JSON.stringify(run.toolFilter) +
        "）",
    );
  });

  it("带 filter 的发起失败 → 去 filter 重试一次（不挂本次 run + 告警留痕）", async () => {
    const fake = fakeSubagents(['{"ok": true}'], {
      toolFilter: true,
      failWithFilter: true,
    });
    const warns: string[] = [];
    const out = await runChildOnce(
      {
        resolve: <T>(name: string): T | undefined =>
          name === "subagents" ? (fake.service as T) : undefined,
        agent: { session: { id: "s1" } },
        warn: (msg) => warns.push(msg),
      },
      {
        label: "task:audit:c1",
        prompt: "审",
        requireParent: true,
        toolFilter: { deny: ["task_stop"] },
      },
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(fake.attempts.length, 2, "先带 filter 失败、再去 filter 重试");
    assert.notEqual(
      fake.attempts[0]?.toolFilter,
      undefined,
      "首次尝试带 filter",
    );
    assert.equal(
      fake.attempts[1]?.toolFilter,
      undefined,
      "重试不带 filter（降级）",
    );
    assert.equal(fake.runs.length, 1, "只有重试那次成功落 run");
    assert.match(
      warns.join("\n"),
      /去 filter 重试一次/,
      "告警留痕: " + warns.join("|"),
    );
  });

  it("runChildOnce：未请求 toolFilter（executor 路径不传）→ 请求不带该字段", async () => {
    const fake = fakeSubagents(['{"ok": true}'], { toolFilter: true });
    const out = await runChildOnce(
      {
        resolve: <T>(name: string): T | undefined =>
          name === "subagents" ? (fake.service as T) : undefined,
        agent: { session: { id: "s1" } },
        warn: () => {},
      },
      { label: "task:exec:c1", prompt: "干活", requireParent: true },
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(fake.runs.length, 1);
    assert.equal(
      fake.runs[0]?.toolFilter,
      undefined,
      "执行后端（executor 路径）不请求工具面收窄",
    );
  });
});

describe("工具注册面：render 全函数（text 恒为 string）", () => {
  it("全部 5 个注册工具：render({}, undefined) 给 string；对象走 JSON、字符串原样", async () => {
    // output.render 只在注册面（toDshTool）产出 → 经 apply 真接线逐个收集
    type RegisteredTool = {
      output?: {
        render?: (
          args: unknown,
          value: unknown,
        ) => Array<{ type: string; text: unknown }>;
      };
    };
    const registered = new Map<string, RegisteredTool>();
    await apply({
      tools: {
        register: (def: unknown) => {
          const tool = def as RegisteredTool & { name: string };
          registered.set(tool.name, tool);
        },
      },
      provide: () => {},
      get: () => undefined,
    });
    const names = [
      "task_decompose",
      "task_implement",
      "task_execute",
      "task_stop",
      "task_status",
    ];
    assert.equal(registered.size, names.length, "应注册全部 5 个工具");
    for (const name of names) {
      const render = registered.get(name)?.output?.render;
      if (render === undefined)
        throw new Error(`工具未注册或缺 output.render：${name}`);
      // 裸 JSON.stringify(value) 在 value === undefined 时返回非字符串（宿主拒畸形块）
      const blocks = render({}, undefined);
      assert.equal(
        typeof blocks[0]?.text,
        "string",
        `${name}：render({}, undefined) 的 text 应为 string`,
      );
      assert.equal(
        render({}, { a: 1 })[0]?.text,
        '{\n  "a": 1\n}',
        `${name}：对象走 JSON 分支`,
      );
      assert.equal(render({}, "s")[0]?.text, "s", `${name}：字符串原样返回`);
    }
  });
});

describe("工具注册面：render 形参顺序哨兵（渲染的必须是第二参）", () => {
  it("全部 5 个注册工具：变异回单形参必失败", async () => {
    type RegisteredTool = {
      output?: {
        render?: (
          args: unknown,
          value: unknown,
        ) => Array<{ type: string; text: unknown }>;
      };
    };
    const registered = new Map<string, RegisteredTool>();
    await apply({
      tools: {
        register: (def: unknown) => {
          const tool = def as RegisteredTool & { name: string };
          registered.set(tool.name, tool);
        },
      },
      provide: () => {},
      get: () => undefined,
    });
    const names = [
      "task_decompose",
      "task_implement",
      "task_execute",
      "task_stop",
      "task_status",
    ];
    assert.equal(registered.size, names.length, "应注册全部 5 个工具");
    // 本包 render 是 jsonText(value)：整个 value 进 JSON 文本，任意字段都会回显 →
    // 最小结构即可。哨兵放 **value 位**；args 用同形结构、标记放同一可回显字段，
    // 形参写反 / 少参（单形参实现）时渲染器拿到的是 args → ②③ 双失败。
    const argsShaped = { marker: "ARGS_MARKER_NOT_RENDERED" };
    const valueShaped = { marker: "SENTINEL_VALUE_MARKER" };
    for (const name of names) {
      const render = registered.get(name)?.output?.render;
      if (render === undefined)
        throw new Error(`工具未注册或缺 output.render：${name}`);
      const text = render(argsShaped, valueShaped)[0]?.text;
      assert.equal(
        typeof text,
        "string",
        `${name}：blocks[0].text 必须是 string`,
      );
      assert.ok(
        String(text).includes("SENTINEL_VALUE_MARKER"),
        `${name}：渲染的必须是第二参（value）`,
      );
      assert.ok(
        !String(text).includes("ARGS_MARKER_NOT_RENDERED"),
        `${name}：第一参（args）不该被当成 value 渲染`,
      );
    }
  });
});
