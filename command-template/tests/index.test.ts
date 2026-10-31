// tests/index.test.ts — 插件服务面：加载 / 注册 / 分派 / 运行 / 配置的判定分支。
//
// 只测 `CommandTemplateService` 的对外方法（不拼 apply，apply 的宿主接线在
// `tests/integration/plugin.test.ts`）；宿主面用最小假命令面 + 记录型 logger 替身。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CommandTemplateService,
  ENTRY_COMMAND,
  type CommandTemplateConfig,
} from "../src/index.ts";

/** 注册到的命令定义（宿主命令面最小形态）. */
interface RegisteredDefinition {
  definitionId: string;
  name: string;
  description: string;
  input: { hint: string };
  handler: (invocation: {
    agent?: { followup?(message: unknown): void };
    rawInput?: string;
    signal?: AbortSignal;
  }) => Promise<{ kind: string; text?: string }>;
}

/** 假命令面 + 记录型 logger 拼出的最小 ctx. */
function fakeCtx(options: { commands?: "direct" | "get" | "none" } = {}) {
  const registered: RegisteredDefinition[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  let disposals = 0;
  const commands = {
    register: (definition: unknown): (() => void) => {
      registered.push(definition as RegisteredDefinition);
      return () => {
        disposals += 1;
      };
    },
  };
  const expose = options.commands ?? "direct";
  const ctx: Record<string, unknown> = {
    logger: () => ({
      info: (message: string) => void logs.push(message),
      warn: (message: string) => void warns.push(message),
    }),
  };
  if (expose === "direct") ctx["commands"] = commands;
  if (expose === "get")
    ctx["get"] = (name: string) => (name === "commands" ? commands : undefined);
  return {
    ctx,
    registered,
    logs,
    warns,
    disposals: () => disposals,
  };
}

/** 建一个临时模板目录, 内容按 `文件名 -> 文本` 写入. */
function templateDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-index-"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** 建一个已加载的服务实例（用户目录指向不存在的子目录，避免读到本机模板）. */
function serviceOf(
  dir: string,
  config: CommandTemplateConfig = {},
  commands: "direct" | "get" | "none" = "direct",
) {
  const env = fakeCtx({ commands });
  const service = new CommandTemplateService(env.ctx, {
    dirs: [dir],
    userDir: join(dir, "none"),
    ...config,
  });
  return { ...env, service, load: () => void service.load() };
}

const HELLO = "---\nname: hello\ndescription: 打招呼\n---\nhi";

test("服务面: 重复注册先撤销旧命令, 模板名与保留子命令冲突只告警", () => {
  const dir = templateDir({
    "list.md": "---\nname: list\ndescription: 与子命令同名\n---\nhi",
  });
  try {
    const env = serviceOf(dir);
    env.load();
    env.service.register();
    env.service.register();
    assert.equal(env.registered.length, 2, "每次注册都提交一条入口命令");
    assert.equal(env.disposals(), 1, "第二次注册先撤销旧命令");
    assert.ok(
      env.logs.some((line) =>
        line.includes("模板名与入口 / 子命令名冲突（无法调用）：list"),
      ),
      env.logs.join("\n"),
    );
    assert.deepEqual(
      env.service.list().map((item) => item.name),
      ["list"],
      "冲突的模板仍加载并出现在 list 里",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("服务面: 撤销旧命令抛错只告警, 新命令照旧注册", () => {
  const dir = templateDir({ "hello.md": HELLO });
  try {
    const env = fakeCtx();
    (env.ctx["commands"] as { register: unknown }).register = (
      definition: unknown,
    ) => {
      env.registered.push(definition as RegisteredDefinition);
      return () => {
        throw new Error("卸载失败");
      };
    };
    const service = new CommandTemplateService(env.ctx, {
      dirs: [dir],
      userDir: join(dir, "none"),
    });
    service.load();
    service.register();
    service.register();
    assert.ok(
      env.logs.some((line) => line.includes("撤销旧命令失败：卸载失败")),
      env.logs.join("\n"),
    );
    assert.equal(env.registered.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("服务面: 命令面缺失或注册抛错时降级为只读服务", () => {
  const dir = templateDir({ "hello.md": HELLO });
  try {
    // 缺命令面: 一条告警, list 仍可用
    const absent = serviceOf(dir, {}, "none");
    absent.load();
    absent.service.register();
    assert.equal(absent.registered.length, 0);
    assert.ok(
      absent.logs.some((line) => line.includes("commands 未挂载")),
      absent.logs.join("\n"),
    );
    assert.deepEqual(
      absent.service.list().map((item) => item.name),
      ["hello"],
      "服务面仍可用",
    );

    // 经 ctx.get 取到命令面
    const viaGet = serviceOf(dir, {}, "get");
    viaGet.load();
    viaGet.service.register();
    assert.equal(viaGet.registered.length, 1);

    // register 抛错: 只告警, 不抛给宿主
    const failing = serviceOf(dir);
    (failing.ctx["commands"] as { register: unknown }).register = () => {
      throw new Error("宿主拒绝");
    };
    failing.load();
    failing.service.register();
    assert.ok(
      failing.logs.some((line) =>
        line.includes("命令注册失败（playbook）：宿主拒绝"),
      ),
      failing.logs.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("服务面: list / get / errors 直接反映加载结果与坏模板原因", () => {
  const dir = templateDir({
    "hello.md": HELLO,
    "broken.md": "---\nname: broken\n---\n缺 description",
  });
  try {
    const env = serviceOf(dir);
    env.load();
    assert.deepEqual(
      env.service.list().map((item) => item.name),
      ["hello"],
    );
    assert.equal(env.service.get("hello")?.description, "打招呼");
    assert.equal(env.service.get("nope"), undefined);
    const errors = env.service.errors();
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.error ?? "", /description 不能为空/);
    assert.ok(
      env.logs.some((line) => line.includes("模板解析失败（跳过）")),
      env.logs.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("管理面: show 缺 name / list 带坏模板 / reload 报重载数量", async () => {
  const dir = templateDir({
    "hello.md": HELLO,
    "broken.md": "---\nname: broken\n---\n缺 description",
  });
  try {
    const env = serviceOf(dir);
    env.load();
    const missing = await env.service.run(ENTRY_COMMAND, {
      rawInput: "show",
    });
    assert.deepEqual(missing, {
      kind: "error",
      text: "模板不存在：(缺 name)",
    });

    const list = await env.service.run(ENTRY_COMMAND, { rawInput: "list" });
    assert.match(list.text ?? "", /^- playbook hello/m);
    assert.match(list.text ?? "", /坏模板：/);
    assert.match(list.text ?? "", /broken\.md：.*description 不能为空/);

    env.service.register();
    const reloaded = await env.service.run(ENTRY_COMMAND, {
      rawInput: "reload",
    });
    assert.match(reloaded.text ?? "", /已重载：模板 1 个，坏模板 1 个/);
    assert.equal(env.disposals(), 1, "reload 会重新注册入口命令");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行: 多步摘要与逐步产出, 模板不存在给出入口提示", async () => {
  const dir = templateDir({
    "two.md":
      "---\nname: two\ndescription: d\nsteps:\n  - id: a\n    type: prompt\n    prompt: 甲\n  - id: b\n    type: prompt\n    prompt: 基于 {{a}}\n---\n",
  });
  try {
    const env = serviceOf(dir);
    env.load();
    const injected: unknown[] = [];
    const result = await env.service.run("two", {
      agent: { followup: (message) => void injected.push(message) },
    });
    assert.equal(result.kind, "success");
    assert.equal(result.text, "已完成 2 步（a → b）\n\n基于 甲");
    assert.equal(injected.length, 2);

    const absent = await env.service.run("nope", {});
    assert.deepEqual(absent, {
      kind: "error",
      text: "模板不存在：nope（/playbook list 查看）",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行: 未解析占位符只告警, 不改变产出", async () => {
  const dir = templateDir({
    "loose.md":
      "---\nname: loose\ndescription: d\n---\n带 {{missing}} 的提示词",
  });
  try {
    const env = serviceOf(dir);
    env.load();
    const result = await env.service.run("loose", {
      agent: { followup: () => {} },
    });
    assert.deepEqual(result, {
      kind: "success",
      text: "已完成\n\n带 {{missing}} 的提示词",
    });
    assert.ok(
      env.logs.some((line) =>
        line.includes("未解析占位符 missing（步骤 step1）"),
      ),
      env.logs.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行: 注入失败与子代理缺席都转成带错误码的命令结果", async () => {
  const dir = templateDir({
    "prompt-only.md": "---\nname: prompt-only\ndescription: d\n---\nhi",
    "agent-step.md":
      "---\nname: agent-step\ndescription: d\nsteps:\n  - id: a\n    type: agent\n    prompt: p\n---\n",
    "too-many.md":
      "---\nname: too-many\ndescription: d\nsteps:\n  - id: a\n    type: prompt\n    prompt: p\n  - id: b\n    type: prompt\n    prompt: q\n---\n",
  });
  try {
    const env = serviceOf(dir, { maxSteps: 1 });
    env.load();

    // followup 抛错 → 注入失败告警 + session_unavailable
    const throwing = await env.service.run("prompt-only", {
      agent: {
        followup: () => {
          throw new Error("会话已拆");
        },
      },
    });
    assert.deepEqual(throwing, {
      kind: "error",
      text: "模板 prompt-only 执行失败（session_unavailable）：注入当前会话失败（会话不在本进程？）",
    });
    assert.ok(
      env.logs.some((line) => line.includes("注入失败：会话已拆")),
      env.logs.join("\n"),
    );

    // 无 agent 面 → session_unavailable（followup 缺失）
    const noAgent = await env.service.run("prompt-only", {});
    assert.equal(noAgent.kind, "error");
    assert.match(noAgent.text ?? "", /session_unavailable/);

    // 子代理服务缺席 → step_failed, 文案指向宿主面
    const agentStep = await env.service.run("agent-step", {});
    assert.equal(agentStep.kind, "error");
    assert.match(
      agentStep.text ?? "",
      /模板 agent-step 执行失败（step_failed）：步骤 a 失败：subagents 服务不可用/,
    );

    // 配置 maxSteps 生效 → template_invalid
    const tooMany = await env.service.run("too-many", {});
    assert.equal(tooMany.kind, "error");
    assert.match(
      tooMany.text ?? "",
      /模板 too-many 执行失败（template_invalid）：步骤数超过上限（2 > 1）/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行: 入口名当模板名时走管理面, 不递归", async () => {
  const dir = templateDir({ "hello.md": HELLO });
  try {
    const env = serviceOf(dir);
    env.load();
    const result = await env.service.run(ENTRY_COMMAND, {
      rawInput: ENTRY_COMMAND,
    });
    assert.equal(result.kind, "success");
    assert.match(result.text ?? "", /^- playbook hello/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
