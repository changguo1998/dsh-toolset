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
import { CommandTemplateService } from "../src/main.ts";
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
  calls: { prompt: string; model?: string }[];
} {
  const injected: string[] = [];
  const calls: { prompt: string; model?: string }[] = [];
  const deps = {
    injected,
    calls,
    injectPrompt: (text: string) => {
      injected.push(text);
      return true;
    },
    runAgent: async (prompt: string, opts: { model?: { model?: string } }) => {
      calls.push({
        prompt,
        ...(opts.model?.model === undefined ? {} : { model: opts.model.model }),
      });
      return `answer(${prompt.slice(0, 12)})`;
    },
    ...overrides,
  };
  return deps as StepDeps & {
    injected: string[];
    calls: { prompt: string; model?: string }[];
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

  const failing = fakeDeps({
    runAgent: async () => {
      throw new Error("boom");
    },
  });
  const failed = await runTemplate(tpl, failing, { rawInput: "" });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "step_failed");
  assert.match(failed.error ?? "", /候选全部失败/);
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

test("服务：注册命令 + /tpl 管理 + 运行（prompt 模板注入当前会话）", async () => {
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
