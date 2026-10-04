/**
 * command-template 测试：模板解析（YAML 子集）/ 参数展开 / 双源加载 / 步骤执行 / 命令注册与运行。
 * 全部用注入替身（不依赖宿主面），真机联调见追踪文档。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expand, splitArgs, unresolvedPlaceholders } from "../src/args.ts";
import { parseTemplate, TemplateParseError } from "../src/frontmatter.ts";
import { loadDefaultTemplates, loadTemplates } from "../src/registry.ts";
import { runTemplate } from "../src/steps.ts";
import {
  apply,
  CommandTemplateService,
  SERVICE_FACE_METHODS,
  serviceFace,
} from "../src/main.ts";
import type { StepDeps, TemplateSpec } from "../src/types.ts";

const SAMPLE = `---
name: demo
description: 演示模板
input: 一个参数
model: deepseek-v4-pro
steps:
  - id: gather
    type: agent
    prompt: |
      收集 $1 的上下文
      （多行）
  - id: review
    type: agent
    prompt: "评审 {{gather}}"
    model: deepseek-flash
    bestOf: 3
    judge:
      prompt: 选最佳
      model:
        provider: deepseek
        model: deepseek-v4-pro
  - id: emit
    type: prompt
    prompt: 请基于 {{review}} 给出结论：$ARGUMENTS
---
`;

test("frontmatter：解析 steps / 块标量 / 模型简写与嵌套 / bestOf+judge", () => {
  const tpl = parseTemplate(SAMPLE, "/tmp/demo.md");
  assert.equal(tpl.name, "demo");
  assert.equal(tpl.description, "演示模板");
  assert.equal(tpl.inputHint, "一个参数");
  assert.deepEqual(tpl.model, { model: "deepseek-v4-pro" });
  assert.equal(tpl.steps.length, 3);
  const [gather, review, emit] = tpl.steps;
  assert.equal(gather?.type, "agent");
  assert.equal(gather?.prompt, "收集 $1 的上下文\n（多行）");
  assert.equal(review?.bestOf, 3);
  assert.equal(review?.model?.model, "deepseek-flash");
  assert.deepEqual(review?.judge?.model, {
    provider: "deepseek",
    model: "deepseek-v4-pro",
  });
  assert.equal(emit?.type, "prompt");
  // 模板级模型继承：agent 步骤未声明 → 取模板 model；judge 不继承
  const inherited = parseTemplate(
    "---\nname: x1\ndescription: d\nmodel: m1\nsteps:\n  - id: a\n    prompt: p\n---\n",
    "/tmp/x1.md",
  );
  assert.equal(inherited.steps[0]?.model?.model, "m1");
});

test("frontmatter：正文缺省为单 prompt 步骤；错误路径报错", () => {
  const body = parseTemplate(
    "---\nname: x2\ndescription: d\n---\n就是一段提示词",
    "/tmp/x2.md",
  );
  assert.equal(body.steps.length, 1);
  assert.equal(body.steps[0]?.type, "prompt");
  assert.equal(body.steps[0]?.prompt, "就是一段提示词");

  const bad = [
    "没有 front-matter",
    "---\ndescription: 缺 name\n---\nx",
    "---\nname: Bad_Name\ndescription: d\n---\nx",
    "---\nname: x3\ndescription: d\nsteps:\n  - id: a\n    prompt: p\n  - id: a\n    prompt: q\n---\n",
    "---\nname: x4\ndescription: d\nsteps:\n  - id: a\n    prompt: { inline: true }\n---\n",
    "---\nname: x5\ndescription: d\nsteps:\n  - id: a\n    type: shell\n    prompt: p\n---\n",
  ];
  for (const text of bad) {
    assert.throws(
      () => parseTemplate(text, "/tmp/bad.md"),
      TemplateParseError,
      text.slice(0, 24),
    );
  }
});

test("args：切分 / 展开 / 未解析占位符", () => {
  assert.deepEqual(splitArgs('a "b c" d'), ["a", "b c", "d"]);
  assert.deepEqual(splitArgs("  "), []);
  assert.equal(expand("$ARGUMENTS / $1 / $2", "x y"), "x y / x / y");
  assert.equal(expand("前 {{a}} 后", "", { a: "A" }), "前 A 后");
  assert.equal(expand("未知 {{b}}", ""), "未知 {{b}}");
  assert.deepEqual(unresolvedPlaceholders("{{b}} {{c}}"), ["b", "c"]);
});

test("registry：双源加载（用户覆盖随包）+ 坏模板隔离", () => {
  const base = mkdtempSync(join(tmpdir(), "ct-reg-"));
  const bundled = join(base, "bundled");
  const user = join(base, "user");
  mkdirSync(bundled);
  mkdirSync(user);
  writeFileSync(
    join(bundled, "a.md"),
    "---\nname: a\ndescription: 随包 A\n---\nA",
  );
  writeFileSync(
    join(bundled, "b.md"),
    "---\nname: b\ndescription: 随包 B\n---\nB",
  );
  writeFileSync(
    join(user, "b.md"),
    "---\nname: b\ndescription: 用户 B\n---\nB2",
  );
  writeFileSync(
    join(user, "c.md"),
    "---\nname: c\ndescription: 用户 C\n---\nC",
  );
  writeFileSync(join(user, "broken.md"), "---\nname: zz\n---\n缺 description");
  try {
    const result = loadDefaultTemplates({ dirs: [bundled], userDir: user });
    assert.deepEqual(
      result.templates.map((t) => t.name),
      ["a", "b", "c"],
    );
    assert.equal(
      result.templates.find((t) => t.name === "b")?.description,
      "用户 B",
    );
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.error, /description/);
    const onlyBundled = loadTemplates([bundled]);
    assert.equal(onlyBundled.templates.length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** 步骤替身：记录注入与子代理调用。 */
function fakeDeps(overrides: Partial<StepDeps> = {}): StepDeps & {
  injected: string[];
  calls: { prompt: string; model?: string; timeoutMs?: number }[];
} {
  const injected: string[] = [];
  const calls: { prompt: string; model?: string; timeoutMs?: number }[] = [];
  const deps = {
    injected,
    calls,
    injectPrompt: (text: string) => {
      injected.push(text);
      return true;
    },
    runAgent: async (
      prompt: string,
      opts: { model?: { model?: string }; timeoutMs?: number },
    ) => {
      calls.push({
        prompt,
        ...(opts.model?.model === undefined ? {} : { model: opts.model.model }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      });
      return `answer(${prompt.slice(0, 12)})`;
    },
    ...overrides,
  };
  return deps as StepDeps & {
    injected: string[];
    calls: { prompt: string; model?: string; timeoutMs?: number }[];
  };
}

function specOf(overrides: Partial<TemplateSpec> = {}): TemplateSpec {
  return {
    name: "t",
    description: "d",
    steps: [{ id: "s1", type: "agent", prompt: "P $1" }],
    source: "/tmp/t.md",
    ...overrides,
  };
}

test("steps：prompt 注入 + agent 串链 + 模型覆盖", async () => {
  const deps = fakeDeps();
  const tpl = specOf({
    steps: [
      {
        id: "gather",
        type: "agent",
        prompt: "收集 $1",
        model: { model: "m1" },
      },
      { id: "emit", type: "prompt", prompt: "基于 {{gather}} 输出" },
    ],
  });
  const outcome = await runTemplate(tpl, deps, { rawInput: "主题" });
  assert.equal(outcome.ok, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0]?.model, "m1");
  assert.equal(deps.injected.length, 1);
  assert.match(deps.injected[0]!, /answer\(收集 主题\)/);
  assert.equal(outcome.text, deps.injected[0]);
});

test("steps：bestOf 并行 + 裁判收到全部候选；全部失败 → step_failed", async () => {
  const seen: string[] = [];
  const deps = fakeDeps({
    runAgent: async (prompt: string) => {
      seen.push(prompt);
      if (prompt.startsWith("选")) return "裁判结论";
      return `候选:${seen.length}`;
    },
  });
  const tpl = specOf({
    steps: [
      {
        id: "r",
        type: "agent",
        prompt: "评审",
        bestOf: 3,
        judge: { prompt: "选最佳" },
      },
    ],
  });
  const outcome = await runTemplate(tpl, deps, { rawInput: "" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.steps[0]?.candidates, 3);
  assert.equal(outcome.steps[0]?.judged, true);
  assert.equal(outcome.text, "裁判结论");
  assert.equal(seen.filter((p) => p === "评审").length, 3);
  assert.match(seen.at(-1)!, /候选 1/);

  // 逐候选不同错误：断言取的是**首个**候选的错误（三个候选同错文案证不了「取首个」）
  let candidateSeq = 0;
  const failing = fakeDeps({
    runAgent: async () => {
      candidateSeq += 1;
      throw new Error(`boom-${candidateSeq}`);
    },
  });
  const failed = await runTemplate(tpl, failing, { rawInput: "" });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "step_failed");
  assert.match(failed.error ?? "", /候选全部失败/);
  assert.match(
    failed.error ?? "",
    /候选首错：boom-1/,
    "带首个候选的失败原因（不吞逐候选错误，且取第一个）",
  );
});

test("steps：上限与注入失败的错误码", async () => {
  const deps = fakeDeps();
  const tooMany = await runTemplate(
    specOf({
      steps: Array.from({ length: 3 }, (_, i) => ({
        id: `s${i}`,
        type: "agent" as const,
        prompt: "p",
      })),
    }),
    deps,
    { rawInput: "", maxSteps: 2 },
  );
  assert.equal(tooMany.code, "template_invalid");
  const bigBestOf = await runTemplate(
    specOf({ steps: [{ id: "s", type: "agent", prompt: "p", bestOf: 9 }] }),
    deps,
    { rawInput: "", maxBestOf: 8 },
  );
  assert.equal(bigBestOf.code, "template_invalid");
  const noSession = await runTemplate(
    specOf({ steps: [{ id: "s", type: "prompt", prompt: "p" }] }),
    fakeDeps({ injectPrompt: () => false }),
    { rawInput: "" },
  );
  assert.equal(noSession.code, "session_unavailable");
});

test("steps：总预算——耗尽 → run_timeout（保留已完成步骤 + 文案可读）", async () => {
  let started = 0;
  const deps = fakeDeps({
    runAgent: async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 50));
      return "ok";
    },
  });
  const tpl = specOf({
    steps: [
      { id: "a", type: "agent", prompt: "p1" },
      { id: "b", type: "agent", prompt: "p2" },
    ],
  });
  const outcome = await runTemplate(tpl, deps, {
    rawInput: "",
    totalTimeoutMs: 10,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "run_timeout");
  assert.deepEqual(
    outcome.steps.map((s) => s.id),
    ["a"],
    "已完成步骤保留在结果里",
  );
  assert.equal(started, 1, "预算耗尽后不再启动新步");
  assert.match(outcome.error ?? "", /超出总预算（10 ms，已用约 \d+ ms）/);
  assert.match(outcome.error ?? "", /已完成：1 步（a）/);
});

test("steps：有效单步超时 = min(stepTimeoutMs, 剩余预算)", async () => {
  const deps = fakeDeps();
  const tpl = specOf();
  // 预算 < stepTimeoutMs → 压到预算
  await runTemplate(tpl, deps, {
    rawInput: "",
    totalTimeoutMs: 1000,
    stepTimeoutMs: 5000,
  });
  assert.ok(
    deps.calls[0]?.timeoutMs !== undefined &&
      deps.calls[0].timeoutMs > 0 &&
      deps.calls[0].timeoutMs <= 1000,
    `被预算压低，收到 ${deps.calls[0]?.timeoutMs}`,
  );
  // 预算充足 → 保持 stepTimeoutMs；非正预算 = 不设预算（同样保持）
  deps.calls.length = 0;
  await runTemplate(tpl, deps, {
    rawInput: "",
    totalTimeoutMs: 100_000,
    stepTimeoutMs: 5,
  });
  assert.equal(deps.calls[0]?.timeoutMs, 5);
  deps.calls.length = 0;
  await runTemplate(tpl, deps, {
    rawInput: "",
    totalTimeoutMs: 0,
    stepTimeoutMs: 5,
  });
  assert.equal(deps.calls[0]?.timeoutMs, 5, "非正预算按「不设」");
});

test("steps：预算窗口内的步骤失败归因到 run_timeout（而非 step_failed）", async () => {
  const deps = fakeDeps({
    runAgent: async () => {
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("boom");
    },
  });
  const outcome = await runTemplate(specOf(), deps, {
    rawInput: "",
    totalTimeoutMs: 10,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "run_timeout");
  // 对照：预算充足时同一失败仍是 step_failed（既有归因不退化）
  const generous = fakeDeps({
    runAgent: async () => {
      throw new Error("boom");
    },
  });
  const stepFailed = await runTemplate(specOf(), generous, { rawInput: "" });
  assert.equal(stepFailed.code, "step_failed");
});

test("服务：注册命令 + /playbook 管理 + 运行（prompt 模板注入当前会话）", async () => {
  const base = mkdtempSync(join(tmpdir(), "ct-svc-"));
  writeFileSync(
    join(base, "hello.md"),
    "---\nname: hello\ndescription: 打招呼\ninput: 名字\n---\n你好 $ARGUMENTS",
  );
  const registrations: { name: string; description: string }[] = [];
  const invoked: string[] = [];
  const ctx = {
    logger: () => ({ info: () => {} }),
    commands: {
      register: (definition: unknown) => {
        registrations.push(definition as { name: string; description: string });
        return () => {};
      },
    },
    provide: () => {},
  };
  try {
    const service = new CommandTemplateService(ctx, {
      dirs: [base],
      userDir: join(base, "none"),
    });
    service.load();
    service.register();
    assert.deepEqual(
      registrations.map((r) => r.name).sort(),
      ["playbook"],
      "统一入口：一条命令 + 子命令（模板不占命名空间）",
    );
    const invocation = {
      agent: {
        followup: (message: unknown) =>
          void invoked.push(JSON.stringify(message)),
      },
      rawInput: "世界",
    };
    const run = await service.run("hello", invocation);
    assert.equal(run.kind, "success");
    assert.match(run.text ?? "", /你好 世界/);
    assert.equal(invoked.length, 1);
    assert.match(invoked[0]!, /command-template/);

    // 入口分派：list / show / reload / <模板> [参数]
    const manage = (await service.run("playbook", { rawInput: "list" })) as {
      kind: string;
      text?: string;
    };
    assert.equal(manage.kind, "success");
    const bare = (await service.run("playbook", { rawInput: "" })) as {
      kind: string;
    };
    assert.equal(bare.kind, "success", "空参数 = list");
    const dispatched = (await service.run("playbook", {
      ...invocation,
      rawInput: "hello 世界",
    })) as {
      kind: string;
      text?: string;
    };
    assert.equal(dispatched.kind, "success", "第一段为模板名时按模板运行");
    assert.match(dispatched.text ?? "", /你好 世界/, "模板参数取剩余输入");
    const showViaEntry = (await service.run("playbook", {
      rawInput: "show hello",
    })) as { text?: string };
    assert.match(showViaEntry.text ?? "", /source: .*hello\.md/);
    const list = new CommandTemplateService(ctx, {
      dirs: [base],
      userDir: join(base, "none"),
    });
    list.load();
    const okInvocation = { agent: { followup: () => {} }, rawInput: "" };
    assert.equal((await list.run("hello", okInvocation)).kind, "success");
    assert.equal((await list.run("nope", okInvocation)).kind, "error");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("服务面：键清单与 SERVICE_FACE_METHODS 同步 + 实现同名方法（守卫）", () => {
  const face = serviceFace({} as unknown as CommandTemplateService);
  assert.deepEqual(
    Object.keys(face).sort(),
    [...SERVICE_FACE_METHODS].sort(),
    "服务面键与 SERVICE_FACE_METHODS 漂移即红",
  );
  for (const method of SERVICE_FACE_METHODS) {
    assert.equal(
      typeof (
        CommandTemplateService.prototype as unknown as Record<string, unknown>
      )[method],
      "function",
      `CommandTemplateService 应实现 ${method}（服务面键与实现同步）`,
    );
  }
});

test("/playbook show 显示总预算生效值（缺省 = maxSteps × stepTimeoutMs）", async () => {
  const base = mkdtempSync(join(tmpdir(), "ct-budget-"));
  writeFileSync(
    join(base, "hello.md"),
    "---\nname: hello\ndescription: 打招呼\n---\nhi",
  );
  const ctx = {
    logger: () => ({ info: () => {} }),
    commands: { register: () => () => {} },
    provide: () => {},
  };
  /** 建一个已加载模板目录的服务实例（config 覆盖按需传入） */
  const mk = (config: Record<string, unknown> = {}) => {
    const service = new CommandTemplateService(ctx, {
      dirs: [base],
      userDir: join(base, "none"),
      ...config,
    });
    service.load();
    return service;
  };
  const show = async (service: CommandTemplateService) =>
    (await service.run("playbook", { rawInput: "show hello" })) as {
      text?: string;
    };
  try {
    // 缺省：maxSteps(12) × stepTimeoutMs(600000)
    const dflt = await show(mk());
    assert.match(
      dflt.text ?? "",
      /budget: 7200000 ms（缺省 = maxSteps × stepTimeoutMs）/,
      dflt.text,
    );
    // 显式 totalTimeoutMs：标注来源
    const explicit = await show(mk({ totalTimeoutMs: 1000 }));
    assert.match(
      explicit.text ?? "",
      /budget: 1000 ms（config\.totalTimeoutMs）/,
      explicit.text,
    );
    // 缺省口径随 maxSteps / stepTimeoutMs 变化
    const scaled = await show(mk({ maxSteps: 2, stepTimeoutMs: 500 }));
    assert.match(
      scaled.text ?? "",
      /budget: 1000 ms（缺省 = maxSteps × stepTimeoutMs）/,
      scaled.text,
    );
    // 非正 / 非有限 = 不设预算（显示须与运行期归一一致，不能显示 0 ms）
    const off = await show(mk({ totalTimeoutMs: 0 }));
    assert.match(
      off.text ?? "",
      /budget: 不设预算（非正 \/ 非有限）（config\.totalTimeoutMs）/,
      off.text,
    );
    const nan = await show(mk({ totalTimeoutMs: Number.NaN }));
    assert.match(
      nan.text ?? "",
      /budget: 不设预算（非正 \/ 非有限）/,
      nan.text,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("服务面：apply() 提供的对象键清单与 SERVICE_FACE_METHODS 同步（守卫）", () => {
  const base = mkdtempSync(join(tmpdir(), "ct-face-"));
  writeFileSync(
    join(base, "hello.md"),
    "---\nname: hello\ndescription: 打招呼\n---\nhi",
  );
  const provided = new Map<string, unknown>();
  try {
    apply(
      {
        logger: () => ({ info: () => {} }),
        commands: { register: () => () => {} },
        provide: (serviceName: string, value: unknown) => {
          provided.set(serviceName, value);
        },
      } as unknown as Parameters<typeof apply>[0],
      { dirs: [base], userDir: join(base, "none") },
    );
    const face = provided.get("commandTemplate") as
      Record<string, unknown> | undefined;
    assert.ok(face !== undefined, "apply 应 provide commandTemplate 服务");
    assert.deepEqual(
      Object.keys(face).sort(),
      [...SERVICE_FACE_METHODS].sort(),
      "apply 实际提供的键与 SERVICE_FACE_METHODS 漂移即红",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("入口分派：`/playbook playbook`（入口名当参数）走管理面——不递归、不爆栈", async () => {
  const base = mkdtempSync(join(tmpdir(), "ct-self-"));
  writeFileSync(
    join(base, "hello.md"),
    "---\nname: hello\ndescription: 打招呼\n---\nhi",
  );
  const ctx = {
    logger: () => ({ info: () => {} }),
    commands: { register: () => () => {} },
    provide: () => {},
  };
  /** 建一个已加载 + 已注册的服务实例（config 覆盖按需传入） */
  const mk = (config: Record<string, unknown> = {}) => {
    const service = new CommandTemplateService(ctx, {
      dirs: [base],
      userDir: join(base, "none"),
      ...config,
    });
    service.load();
    service.register();
    return service;
  };
  try {
    // 入口名当第一段：应走管理面（list）——原先会 run → #dispatch → run 递归到爆栈
    const self = (await mk().run("playbook", { rawInput: "playbook" })) as {
      kind: string;
      text?: string;
    };
    assert.equal(self.kind, "success", JSON.stringify(self));
    assert.match(self.text ?? "", /hello/, "输出模板清单: " + self.text);
    // 带参数同样不递归（第一段仍是入口名）
    const withArg = (await mk().run("playbook", {
      rawInput: "playbook 世界",
    })) as { kind: string; text?: string };
    assert.equal(withArg.kind, "success", JSON.stringify(withArg));
    assert.match(withArg.text ?? "", /hello/);
    // 入口名守卫与 reservedNames 配置无关：收窄子命令名后仍不递归
    const narrowed = (await mk({ reservedNames: ["list"] }).run("playbook", {
      rawInput: "playbook",
    })) as { kind: string };
    assert.equal(
      narrowed.kind,
      "success",
      "入口名守卫不依赖 reservedNames 配置",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
